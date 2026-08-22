export interface AnswerChoice {
  id: string;
  text: string;
}

export interface Explanation {
  correct_rationale: string;
  distractor_rationale: {
    [key: string]: string;
  };
}

export interface CheckResult {
  correctness: string;
  distractor_quality: string;
  clarity: string;
  difficulty_alignment: string;
  domain_skill_alignment: string;
  originality: string;
  bias_sensitivity: string;
}

export interface ValidationBlock {
  validation_status: "PASS" | "FAIL";
  accuracy_score: number;
  checks: CheckResult;
  feedback: string;
  revised_suggestion?: string;
  timestamp?: string;
  independent_derivation?: string;
}

export interface QuestionMetadata {
  created_at: string;
  model_version: string;
  config_version: string;
  exam_specific: Record<string, any>;
}

export interface Question {
  question_id: string;
  exam_type: string;
  section: string;
  domain: string;
  skill_tag: string;
  difficulty: string;
  passage_intro?: string | null;
  passage: string | null;
  stimulus: string | null;
  question_text: string;
  answer_choices: AnswerChoice[];
  correct_answer: string;
  explanation: Explanation;
  similarity_score: number;
  similar_question_id: string | null;
  embedding?: number[];
  generation_attempt: number;
  validation?: ValidationBlock;
  metadata: QuestionMetadata;
  status: "approved" | "rejected" | "escalated";
  // Which agent actually produced this question. "claude" = a real Claude
  // generation. "simulated_fallback" = the Anthropic call failed (rate limit,
  // timeout, auth, malformed response, etc.) and the pipeline substituted a
  // canned template question instead. Simulated-fallback questions are never
  // auto-approved (see pipeline.ts) — they always route to escalated — but
  // this field lets the UI/export flag them explicitly so they can never be
  // silently mistaken for real AI output.
  // Optional because seed-bank questions (src/server/seedData.ts) are
  // neither Claude-generated nor a simulated fallback — they're curated
  // reference data and simply don't have this field. Anything produced by
  // the live pipeline always sets it explicitly (see pipeline.ts).
  generation_source?: "claude" | "simulated_fallback";
}

export interface Domain {
  name: string;
  skills: string[];
}

export interface Section {
  name: string;
  question_formats: string[];
  domains: Domain[];
}

export interface DifficultyScale {
  label: string;
  definition: string;
}

export interface RubricCheck {
  id: string;
  description: string;
  weight: number;
}

export interface ValidationRubric {
  min_composite_score: number;
  zero_tolerance_checks: string[];
  checks: RubricCheck[];
}

export interface TestProfileConfig {
  exam_type: string;
  name: string;
  description: string;
  sections: Section[];
  difficulty_scale: DifficultyScale[];
  style_rules: string[];
  validation_rubric: ValidationRubric;
}

export interface PipelineStepLog {
  timestamp: string;
  type: "draft" | "critique" | "finalize" | "pre_filter" | "validate" | "decision" | "rag_retrieval";
  message: string;
  details?: any;
}

export interface PipelineRun {
  question_id: string;
  exam_type: string;
  section: string;
  domain: string;
  skill_tag: string;
  difficulty: string;
  current_attempt: number;
  max_attempts: number;
  logs: PipelineStepLog[];
  status: "running" | "completed_pass" | "completed_escalated" | "failed" | "cancelled";
  final_question?: Question;
  started_at?: string;
  stop_requested?: boolean;
}

export interface ValidationAuditLog {
  id: string;
  question_id: string;
  exam_type: string;
  section: string;
  domain: string;
  skill_tag: string;
  difficulty: string;
  accuracy_score: number;
  validation_status: "PASS" | "FAIL";
  generation_attempt: number;
  checks: CheckResult;
  feedback: string;
  timestamp: string;
}

// ─── Batch Generation Types (exam-agnostic) ──────────────────────────────────

export interface BatchRunItem {
  section: string;
  domain: string;
  skill_tag: string;
  difficulty: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled" | "skipped";
  question_id?: string;
  question_status?: string;
  // True when the final saved question for this item came from the
  // simulated-fallback template rather than a real Claude generation
  // (mirrors Question.generation_source, kept here too so the batch UI can
  // flag it without a second DB round trip).
  is_simulated?: boolean;
  error?: string;
  started_at?: string;
  finished_at?: string;
  last_message?: string;   // <-- add this line
  initialFeedback?: string;
}

export interface BatchRun {
  batch_id: string;
  exam_type: string;
  total: number;
  completed: number;
  // NEW: split out of `completed` so the UI can tell the difference between
  // "the pipeline finished and the question was approved" vs "the pipeline
  // finished but hit max_attempts and had to escalate to human review".
  // Previously both cases only incremented `completed`, which is why a
  // batch could report e.g. "40/50 completed" in green/success styling
  // even when most of those 40 were actually escalated, not approved.
  approved: number;
  escalated: number;
  // Real technical failures only: a thrown exception before/during
  // generation (API error, item timeout, crashed call). Never includes
  // user-initiated stops — see `cancelled` below — so this number always
  // matches something you can trace to an actual error message via
  // `item.error`.
  failed: number;
  // Items that never got a chance to finish because the batch was stopped
  // (the Stop button) while they were running. Previously these were
  // counted under `failed`, which made "N failed" look like N technical
  // errors when some of them were just stop-requests landing mid-item.
  cancelled: number;
  status: "running" | "completed" | "completed_with_escalations" | "completed_with_errors" | "failed" | "stopped";
  items: BatchRunItem[];
  started_at: string;
  finished_at?: string;
  userId?: string;
  stop_requested?: boolean;
}

// ─── RAG Types ────────────────────────────────────────────────────────────────

export interface RAGChunk {
  chunkId: string;
  text: string;
  vector: number[];
  metadata: {
    domain: string;
    difficulty: string;
    source: string;
    chunkIndex: number;
  };
}

export interface RAGRetrievalResult {
  exemplars: string[];
  query: {
    domain: string;
    skill: string;
    difficulty: string;
  };
  count: number;
}

// ─── Light Validator Types (Gemini-lite sanity check, separate feature) ─────
//
// This is a fully independent side-channel: a human uploads a JSON file of
// already-approved/reviewed questions (the "human-review export" schema —
// see the sample batch JSON), a lightweight Gemini model gives each one a
// quick qualitative read, and anything it calls "fine" is auto-saved into
// its own separate bank. It never touches the `questions` collection, the
// internal `Question` shape above, or the Grok-based validatorAgent.ts.

// Loose/permissive shape for an uploaded row. Intentionally NOT the same as
// `Question` — the human-review export has a different flat schema (choices
// as a Record, a single string `explanation`, review/consensus metadata,
// etc.) and this feature only reads/displays/re-exports these rows as-is,
// so there's no need to normalize them into the internal Question type.
export interface LightValidatorUploadItem {
  id?: string;
  section?: string;
  category?: string;
  subSkill?: string | null;
  questionType?: string;
  difficulty?: string;
  passage?: string | null;
  stimulus?: string | null;
  imageUrl?: string | null;
  question: string;
  choices: Record<string, string>;
  correct_answer: string;
  explanation?: string;
  // The human-review export has many more fields (reviewStatus, comments,
  // consensusReviews, etc.) — pass them through untouched rather than
  // enumerating every one here.
  [key: string]: any;
}

export interface LightValidatorResult {
  overall_impression: "fine" | "needs_attention";
  // Per-criterion pass/fail from the six checks the agent runs: is the
  // correct answer defensible, are choices reasonable, is the question
  // complete, does the explanation support the answer, is the difficulty
  // label accurate, and does it read as a genuine question for the stated
  // exam type. Absent on conservative fallback results (see
  // lightValidatorAgent.ts) since no real check ran.
  checks?: {
    correct_answer_defensible: boolean;
    choices_reasonable: boolean;
    question_complete: boolean;
    explanation_supports_answer: boolean;
    difficulty_aligned: boolean;
    exam_style_aligned: boolean;
  };
  flags: string[];
  notes: string;
  model: string;
  timestamp: string;
  // True only when no API key was configured or the Gemini call itself
  // failed after retries — this is a conservative fallback, never a real
  // "fine" read. See lightValidatorAgent.ts.
  simulated?: boolean;
  // True when the fallback above was specifically caused by the Gemini API
  // rejecting every retry with a rate-limit/quota error even after our own
  // internal throttling — a strong signal that the configured API key's
  // quota/credits are exhausted rather than a one-off blip. See
  // lightValidatorAgent.ts's isQuotaExhaustedError.
  quotaExceeded?: boolean;
}

// A row saved into the separate Light Validator bank: the original uploaded
// item plus the verdict that got it saved.
export interface LightValidatedQuestion extends LightValidatorUploadItem {
  light_validator_id: string;
  light_validation: LightValidatorResult;
  saved_at: string;
}

// A row saved into the separate "needs_attention" bank — same shape as
// LightValidatedQuestion but persisted whenever a run's verdict was
// needs_attention (including items skipped outright due to quota
// exhaustion), so flagged questions survive past the run that produced
// them instead of only existing in that run's in-memory/localStorage
// results. Its own Mongo collection — never mixed with the "fine" bank
// above or the Live Question Bank.
export interface LightValidatorFlaggedQuestion extends LightValidatorUploadItem {
  light_validator_id: string;
  light_validation: LightValidatorResult;
  flagged_at: string;
}

// One row's outcome within a single upload run, as shown in the tab —
// covers both "fine" (auto-saved) and "needs_attention" (shown, not saved).
export interface LightValidatorRunItem {
  index: number;
  input: LightValidatorUploadItem;
  result: LightValidatorResult;
  saved: boolean;
}

export interface LightValidatorRunSummary {
  success?: boolean;
  status?: "running" | "completed" | "failed" | "stopped";
  // Echoed back from the job store so the client can persist it (localStorage)
  // and resume polling the same job after a page reload without losing track
  // of an in-progress run.
  job_id?: string;
  processed?: number;
  total: number;
  saved: number;
  needs_attention: number;
  bank_count: number;
  // Count of everything currently in the separate flagged bank (see
  // LightValidatorFlaggedQuestion above), refreshed at the same time as
  // bank_count once the run finishes/stops.
  flagged_count?: number;
  results: LightValidatorRunItem[];
  error?: string;
  // Set once any item in the run comes back with LightValidatorResult.quotaExceeded
  // — surfaced at the job level so the UI can show a persistent "API
  // credits/quota exhausted" banner instead of that only being buried inside
  // individual row flags.
  quotaExceeded?: boolean;
  // Human-readable log lines for run-level problems (currently just quota/
  // credit exhaustion notices) — kept distinct from per-row `flags`, and
  // persisted with the rest of the job so it survives a reload.
  errorLog?: string[];
}