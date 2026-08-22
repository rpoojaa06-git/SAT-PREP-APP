import { GoogleGenAI } from '@google/genai';
import { LightValidatorUploadItem, LightValidatorResult } from '../../types';

// Separate on purpose from BOTH the heavy Grok validator (validatorAgent.ts)
// AND the RAG embedder's Gemini client (rag/embeddings.ts): its own API key
// and model env vars, its own client instance, so nothing here can share
// quota, config, or a code path with either of those.
const DEFAULT_MODEL = "gemini-3.1-flash-lite";

let aiClient: GoogleGenAI | null = null;

function getApiKey(): string | undefined {
  return process.env.VALIDATOR_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
}

function getAI(): GoogleGenAI {
  if (!aiClient) {
    aiClient = new GoogleGenAI({
      apiKey: getApiKey() || 'DUMMY_KEY',
      httpOptions: {
        headers: { 'User-Agent': 'light-validator' },
      },
    });
  }
  return aiClient;
}

function getModel(): string {
  return process.env.LIGHT_VALIDATOR_GEMINI_MODEL || DEFAULT_MODEL;
}

// ── In-process rate limiter for the Gemini free tier ──────────────────────
// The free tier caps generate_content at 15 requests/minute for this model.
// server.ts fires several workers concurrently (CONCURRENCY), which can
// burst well past 15 calls within seconds — every call funnels through this
// limiter first and blocks until there's room in the trailing 60s window.
// Set below the real ceiling (12, not 15) to leave headroom for retries
// landing inside the same window.
const RATE_LIMIT_MAX_REQUESTS = 12;
const RATE_LIMIT_WINDOW_MS = 60_000;
const requestTimestamps: number[] = [];

async function waitForRateLimitSlot(): Promise<void> {
  while (true) {
    const now = Date.now();
    while (requestTimestamps.length && now - requestTimestamps[0] > RATE_LIMIT_WINDOW_MS) {
      requestTimestamps.shift();
    }
    if (requestTimestamps.length < RATE_LIMIT_MAX_REQUESTS) {
      requestTimestamps.push(now);
      return;
    }
    const waitMs = RATE_LIMIT_WINDOW_MS - (now - requestTimestamps[0]) + 50;
    await new Promise(r => setTimeout(r, waitMs));
  }
}

// Google's 429 body includes a suggested wait, e.g. "retryDelay":"28s" —
// pull that out and use it verbatim instead of a fixed short backoff.
// Retrying after only 500ms–1s (the old behavior) just re-hits the same
// quota wall immediately.
function parseRetryDelayMs(err: any): number | null {
  const msg = err?.message || "";
  const match = msg.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (match) return Math.ceil(parseFloat(match[1]) * 1000);
  return null;
}

function isRateLimitError(err: any): boolean {
  const msg = (err?.message || "").toLowerCase();
  return err?.code === 429 || msg.includes("429") || msg.includes("resource_exhausted") || msg.includes("quota");
}

// Distinguishes a hard "the API key is out of quota/credits" failure from an
// ordinary short-lived 429 that just needs a brief backoff. Google reports
// both cases the same way (HTTP 429 / RESOURCE_EXHAUSTED), so the message
// itself is the only signal:
//   - A per-minute rate-limit response usually comes with a machine-readable
//     "retryDelay" telling the caller how long to wait — that's transient.
//   - A billing/quota-exhausted response either says so explicitly
//     (insufficient_quota, "exceeded your current quota", billing) or omits
//     retryDelay entirely.
// It's also meaningful that every call already funnels through
// waitForRateLimitSlot() above, which keeps us under 12 requests/minute on
// our own — so a 429 reaching this function at all means Gemini rejected a
// call that our own throttling should have made safe, which is itself a
// strong signal the account's quota/credits (not just this minute's rate)
// are the real problem.
function isQuotaExhaustedError(err: any): boolean {
  if (!isRateLimitError(err)) return false;
  const msg = (err?.message || "").toLowerCase();
  if (msg.includes("insufficient_quota") || msg.includes("exceeded your current quota") || msg.includes("billing")) {
    return true;
  }
  return parseRetryDelayMs(err) === null;
}

// Finds the first *complete, balanced* {...} object in a string, tracking
// string literals (so a "}" or "{" inside a quoted value doesn't throw off
// the brace count) and escape sequences within those literals. Returns the
// substring of just that object, or null if no complete object is found.
// This replaces a naive greedy regex that matched from the first "{" to the
// very last "}" in the whole text, which pulled in trailing garbage
// whenever Gemini appended anything after the real JSON.
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escapeNext) {
        escapeNext = false;
      } else if (ch === "\\") {
        escapeNext = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null; // never closed — incomplete/truncated response
}

const SYSTEM_PROMPT = `You are a fast, lightweight sanity-checker for standardized-test (SAT/GRE-style) multiple-choice questions that have already passed a human review pass.

This is NOT a full rubric-based grading pass — a heavier validator already exists elsewhere for that. Your job is a quick qualitative "does this look fine or not" read against six specific checks:

1. correct_answer_defensible — Is the marked correct answer actually correct, or at least clearly defensible? Work the problem/passage out yourself before trusting the label.
2. choices_reasonable — Are the answer choices reasonable (no duplicate choices, nothing obviously nonsensical, unrelated, or a giveaway)?
3. question_complete — Is the question itself complete and self-contained: no missing context, no truncated text, no broken references like "the passage above" when there's no passage, no placeholder/lorem-ipsum text, nothing cut off mid-sentence?
4. explanation_supports_answer — If an explanation is provided, does it roughly support the marked correct answer (doesn't need to be perfect prose)? If no explanation was given, treat this check as passed (true) — there's nothing to contradict.
5. difficulty_aligned — Does the question's actual difficulty roughly match its labeled difficulty (easy/medium/hard, or whatever scale was given)? An "easy" question with multi-step reasoning, or a "hard" question that's trivial, should fail this.
6. exam_style_aligned — Does this read like a genuine, real question from the stated exam (format, tone, length, answer-choice style, typical content)? Flag anything that reads like a generic trivia question, an obviously AI-generated filler question, or doesn't match the conventions of that exam.

Do NOT nitpick style, phrasing preferences, or minor wording choices beyond what these six checks call for. Only fail a check when you'd genuinely tell a reviewer "something is wrong here."

Respond with ONLY a single JSON object, no markdown code fences, no preamble, exactly matching this shape:
{"overall_impression": "fine" | "needs_attention", "checks": {"correct_answer_defensible": boolean, "choices_reasonable": boolean, "question_complete": boolean, "explanation_supports_answer": boolean, "difficulty_aligned": boolean, "exam_style_aligned": boolean}, "flags": string[], "notes": string}

- "overall_impression": "fine" only if ALL six checks are true; "needs_attention" if any one of them is false.
- "checks": your true/false verdict for each of the six checks above.
- "flags": one short specific note per FAILED check explaining what's wrong (empty array if all six passed).
- "notes": one or two sentences summarizing your read, in plain language.`;

function buildUserPrompt(item: LightValidatorUploadItem, examType?: string): string {
  const choicesText = Object.entries(item.choices || {})
    .map(([key, text]) => `${key}) ${text}`)
    .join("\n");

  // item.exam_type (per-question, if the uploaded file carries it) wins over
  // the exam profile the run was started from — the individual question's
  // own metadata is more specific than a run-wide default.
  const resolvedExamType = item.exam_type || examType || "SAT";

  return [
    `Expected exam type: ${resolvedExamType}`,
    item.section ? `Section: ${item.section}` : null,
    item.category ? `Category: ${item.category}` : null,
    item.difficulty ? `Labeled difficulty: ${item.difficulty}` : "Labeled difficulty: (none given — skip the difficulty_aligned check as true if there's nothing to compare against)",
    item.passage ? `Passage:\n${item.passage}` : null,
    item.stimulus ? `Stimulus:\n${item.stimulus}` : null,
    `Question:\n${item.question}`,
    choicesText ? `Choices:\n${choicesText}` : null,
    item.correct_answer ? `Marked correct answer: ${item.correct_answer}` : null,
    item.explanation ? `Explanation given:\n${item.explanation}` : null,
  ].filter(Boolean).join("\n\n");
}

// Conservative on purpose: whenever we can't actually run the check (no key,
// call failed after retries, unparseable response), we return
// "needs_attention" — never "fine" — so nothing gets auto-filed into the
// bank without a real Gemini read backing it up.
function fallbackResult(model: string, reason: string, quotaExceeded = false): LightValidatorResult {
  return {
    overall_impression: "needs_attention",
    flags: [reason],
    notes: quotaExceeded
      ? "The Light Validator check could not be completed because the Gemini API key appears to be out of quota/credits, so this item was conservatively marked needs_attention rather than silently passed."
      : "The Light Validator check could not be completed, so this item was conservatively marked needs_attention rather than silently passed.",
    model,
    timestamp: new Date().toISOString(),
    simulated: true,
    ...(quotaExceeded ? { quotaExceeded: true } : {}),
  };
}

export async function runLightValidatorAgent(item: LightValidatorUploadItem, examType?: string): Promise<LightValidatorResult> {
  const model = getModel();

  if (!getApiKey()) {
    console.warn("[LightValidator] Neither VALIDATOR_GEMINI_API_KEY nor GEMINI_API_KEY is set.");
    return fallbackResult(model, "No Gemini API key configured for the Light Validator.");
  }

  const REQUEST_TIMEOUT_MS = 12000;
  const maxRetries = 2;
  let lastError: any = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await waitForRateLimitSlot();

      const ai = getAI();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      let res: any;
      try {
        res = await ai.models.generateContent({
          model,
          contents: buildUserPrompt(item, examType),
          config: {
            systemInstruction: SYSTEM_PROMPT,
            responseMimeType: "application/json",
            temperature: 0.0,
            abortSignal: controller.signal,
          },
        });
      } finally {
        clearTimeout(timeoutId);
      }

      const text: string = res?.text ?? "";
      if (!text) {
        throw new Error("Empty response from Gemini.");
      }

      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Occasionally the model wraps the JSON in stray text despite the
        // system prompt — pull out the first {...} block as a fallback
        // before giving up, mirroring the parsing leniency in validatorAgent.ts.
        //
        // A naive /\{[\s\S]*\}/ regex is greedy: it matches from the FIRST
        // "{" to the LAST "}" anywhere in the whole response. If Gemini
        // appends anything after the real JSON object (stray text, a
        // second fragment), that grabs garbage between the two and
        // JSON.parse throws — uncaught, since this fallback had no
        // try/catch of its own. Use a balanced-brace, string-literal-aware
        // scanner instead so we only ever pull out the first *complete*
        // JSON object.
        const extracted = extractFirstJsonObject(text);
        if (!extracted) throw new Error("Could not parse JSON from Gemini response.");
        try {
          parsed = JSON.parse(extracted);
        } catch (parseErr: any) {
          throw new Error(`Extracted JSON block failed to parse: ${parseErr.message}`);
        }
      }

      const CHECK_KEYS = [
        "correct_answer_defensible",
        "choices_reasonable",
        "question_complete",
        "explanation_supports_answer",
        "difficulty_aligned",
        "exam_style_aligned",
      ] as const;

      // Trust the model's per-check booleans when present, but don't trust
      // its own "overall_impression" label blindly — derive the real verdict
      // from whether every individual check actually passed. This way a
      // model that says "fine" but marks one check false still gets caught.
      const checks: Record<(typeof CHECK_KEYS)[number], boolean> = {} as any;
      for (const key of CHECK_KEYS) {
        checks[key] = parsed?.checks?.[key] === true;
      }
      const allChecksPassed = CHECK_KEYS.every((key) => checks[key]);

      const overall: "fine" | "needs_attention" = allChecksPassed ? "fine" : "needs_attention";

      return {
        overall_impression: overall,
        checks,
        flags: Array.isArray(parsed?.flags) ? parsed.flags.map((f: any) => String(f)) : [],
        notes: typeof parsed?.notes === "string" ? parsed.notes : "",
        model,
        timestamp: new Date().toISOString(),
      };

    } catch (err: any) {
      lastError = err;
      const errMsg = err?.message || "";
      const isTimeout = err?.name === "AbortError" || errMsg.toLowerCase().includes("abort");
      const rateLimited = isRateLimitError(err);
      console.warn(
        `[LightValidator] Attempt ${attempt}/${maxRetries} failed${isTimeout ? " (timeout)" : ""}${rateLimited ? " (rate limited)" : ""}: ${errMsg}`
      );
      if (attempt < maxRetries) {
        const suggestedDelay = rateLimited ? parseRetryDelayMs(err) : null;
        const backoffMs = suggestedDelay ?? (isTimeout ? 500 : 1000);
        await new Promise(r => setTimeout(r, backoffMs));
      }
    }
  }

  const quotaExceeded = isQuotaExhaustedError(lastError);
  if (quotaExceeded) {
    console.error(
      `[LightValidator] Gemini API quota/credits appear to be exhausted — all ${maxRetries} attempts were rate-limited even after internal throttling: ${lastError?.message || "unknown error"}`
    );
    return fallbackResult(
      model,
      `Gemini API quota/credits appear to be exhausted: ${lastError?.message || "unknown error"}`,
      true
    );
  }

  console.warn("[LightValidator] All attempts failed — returning needs_attention fallback.", lastError?.message);
  return fallbackResult(model, `Gemini call failed: ${lastError?.message || "unknown error"}`);
}