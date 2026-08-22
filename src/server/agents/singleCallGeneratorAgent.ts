// src/server/agents/singleCallGeneratorAgent.ts
//
// DROP-IN alternative to the 3-stage pipeline in generatorAgent.ts
// (generateScenarioDraft -> solveScenario -> generateWrongChoices = 3
// Claude calls per question). Instead, ONE static, subject+difficulty-
// specific system prompt is selected via promptSelector.ts (see
// ../prompts/) and a SINGLE tool-forced Claude call returns the fully
// drafted, solved, and distractor-equipped question.
//
// The result is then reshaped and passed through the REAL, exported
// `assembleChoices()` from generatorAgent.ts, so the label-stripping,
// null-normalizing, dedup, and shuffle logic lives in exactly one place
// and stays byte-for-byte consistent between the old 3-call pipeline and
// this new single-call path. `getAI()` is likewise reused from
// generatorAgent.ts rather than creating a second Anthropic client.
//
// RAG retrieval is untouched: retrieveExemplarQuestionsForGeneration() is
// called with the exact same params the 3-stage pipeline already uses.
//
// This file does NOT touch validatorAgent.ts (Grok) at all — Grok
// remains the single validator for every question produced here, exactly
// as it is for questions produced by the 3-stage pipeline. This module
// only changes how the DRAFT is generated, not how it is validated.

import Anthropic from '@anthropic-ai/sdk';
import getLangfuse from '../langfuse';
import { getSystemPromptForRequest, Subject, Difficulty } from '../prompts/promptSelector';
import { retrieveExemplarQuestionsForGeneration } from '../rag/ragSystem';
import { getAI, assembleChoices } from './generatorAgent';
import { Question, PipelineStepLog } from '../../types';

// Same model the 3-stage pipeline uses in generatorAgent.ts — kept as a
// separate local constant (rather than importing the private one) so this
// file has no hidden coupling to generatorAgent.ts internals beyond the
// two functions it explicitly exports.
const GENERATOR_MODEL = 'claude-sonnet-5';
const REQUEST_TIMEOUT_MS = 45000;

export interface SingleCallGenerateParams {
  subject: string;           // "Math" | "Reading and Writing" (raw, normalized by promptSelector)
  examType: string;
  domain: string;
  skill: string;
  difficulty: string;        // "Easy" | "Medium" | "Hard"
  studentLevel?: string;
  feedback?: string;         // present only on a retry
  onStep?: (log: PipelineStepLog) => void | Promise<void>;
  logTag?: string;
}

async function buildExemplarBlock(params: SingleCallGenerateParams): Promise<string> {
  const exemplars = await retrieveExemplarQuestionsForGeneration({
    subject: params.subject,
    domain: params.domain,
    skill: params.skill,
    difficulty: params.difficulty,
    topK: 3,
  });

  if (!exemplars || exemplars.length === 0) return '';

  const exemplarContext = exemplars
    .map((ex: any, i: number) => {
      const choiceLines = (ex.answer_choices ?? ex.choices ?? [])
        .map((c: any) => `    ${c.choice_id ?? c.id}: ${c.choice_text ?? c.text}`)
        .join('\n');
      return `Example ${i + 1}:\nQuestion: ${ex.question_text}\n${choiceLines}\nCorrect: ${ex.correct_answer}`;
    })
    .join('\n\n');

  return `\n\nGOLD STANDARD COLLEGE BOARD EXEMPLARS (MODEL YOUR QUESTION DRESS, RIGOR, AND STRUCTURE DIRECTLY AFTER THESE):\n${exemplarContext}\nINSTRUCTION: Match the exact sophistication, vocabulary density, sentence syntax, and mathematical complexity of the exemplars above. Do NOT copy the topic, but match the exact intellectual caliber.`;
}

function buildUserPrompt(params: SingleCallGenerateParams, exemplarBlock: string): string {
  const { domain, skill, difficulty, studentLevel, feedback } = params;

  const feedbackBlock = feedback
    ? `\n\nCRITICAL FEEDBACK from a previous attempt: "${feedback}". You MUST resolve this and avoid repeating this exact issue.`
    : '';

  const studentLevelLine = studentLevel ? `\n- Student Level: ${studentLevel}` : '';

  return `Generate a new original ${difficulty}-tier question for the domain and skill below.
${feedbackBlock}

Specifications:
- Domain: ${domain}
- Skill: ${skill}${studentLevelLine}

Follow every rule in the system prompt exactly, including the required output schema. Return your answer only via the provided tool call.${exemplarBlock}`;
}

const GENERATE_QUESTION_TOOL = {
  name: 'generate_full_question',
  description:
    'Returns one fully drafted, solved, and distractor-equipped SAT question in a single structured object.',
  input_schema: {
    type: 'object' as const,
    properties: {
      passage_intro: { type: ['string', 'null'] },
      passage: { type: ['string', 'null'] },
      stimulus: { type: ['string', 'null'] },
      question_text: { type: 'string' },
      correct_answer: { type: 'string' },
      choices: {
        type: 'array',
        minItems: 4,
        maxItems: 4,
        items: {
          type: 'object',
          properties: {
            choice_text: { type: 'string' },
            is_correct: { type: 'boolean' },
            rationale: { type: 'string' },
          },
          required: ['choice_text', 'is_correct', 'rationale'],
        },
      },
      solution: {
        type: 'object',
        properties: {
          step_by_step: { type: 'string' },
          explanation: { type: 'string' },
        },
        required: ['step_by_step', 'explanation'],
      },
      verification: {
        type: ['object', 'null'],
        properties: {
          equation_lhs: { type: 'string' },
          equation_rhs: { type: 'string' },
          variable: {},       // string or string[]
          variable_value: {}, // number or number[]
        },
      },
    },
    required: ['question_text', 'correct_answer', 'choices', 'solution'],
  },
} as unknown as Anthropic.Tool;

/**
 * Generates ONE complete question with a SINGLE Claude API call (instead
 * of the 3-stage pipeline's 3 calls: draft -> solve -> distractors). Only
 * the one static prompt file matching this subject+difficulty is loaded
 * via promptSelector.ts.
 */
export async function generateQuestionSingleCall(params: SingleCallGenerateParams): Promise<Question> {
  const trace = getLangfuse().trace({
    name: 'claude-question-generation-single-call',
    tags: [params.examType, params.subject],
    metadata: {
      domain: params.domain,
      skill: params.skill,
      difficulty: params.difficulty,
      studentLevel: params.studentLevel,
      feedback: params.feedback ? 'yes' : 'no',
      mode: 'single-call-prompt-split',
    },
  });

  await params.onStep?.({
    timestamp: new Date().toISOString(),
    type: 'draft',
    message: `Generator Agent (single-call): Starting generation for ${params.examType} ${params.subject} / ${params.domain} / ${params.skill} / ${params.difficulty}`,
  });

  const systemPrompt = getSystemPromptForRequest(params.subject, params.difficulty);
  const exemplarBlock = await buildExemplarBlock(params);
  const userPrompt = buildUserPrompt(params, exemplarBlock);

  await params.onStep?.({
    timestamp: new Date().toISOString(),
    type: 'rag_retrieval',
    message: exemplarBlock
      ? `RAG: Retrieved exemplar(s) for "${params.domain} / ${params.skill} / ${params.difficulty}".`
      : `RAG: No exemplars found (or unavailable) — proceeding with prompt-only generation.`,
  });

  console.log(`[Generator][SingleCall] Calling model with tool 'generate_full_question': ${GENERATOR_MODEL}`);
  const __callStart = Date.now();

  const response = await getAI().messages.create(
    {
      model: GENERATOR_MODEL,
      max_tokens: 8192, // covers draft + solve + distractors in one output; raise if Hard Math truncates
      system: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: userPrompt }],
      tools: [GENERATE_QUESTION_TOOL],
      tool_choice: { type: 'tool', name: 'generate_full_question' },
    },
    { timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 }
  );

  {
    const elapsedMs = Date.now() - __callStart;
    const usage = (response as any)?.usage || {};
    console.log(
      `[Generator][SingleCall][Metrics] 'generate_full_question' took ${elapsedMs}ms — ` +
      `input=${usage.input_tokens ?? 0} output=${usage.output_tokens ?? 0} ` +
      `cache_read=${usage.cache_read_input_tokens ?? 0} cache_write=${usage.cache_creation_input_tokens ?? 0}`
    );
    try {
      const generation = trace.generation({
        name: 'generate_full_question',
        model: GENERATOR_MODEL,
        input: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      });
      generation.end({
        output: response,
        usageDetails: {
          input: usage.input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
          cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        },
      });
    } catch (e) {
      console.warn('[Generator][SingleCall] Langfuse generation logging failed (non-fatal):', e);
    }
  }

  if (response.stop_reason === 'max_tokens') {
    throw new Error(
      `[Generator][SingleCall] Claude call for 'generate_full_question' was truncated (stop_reason=max_tokens) — the tool input is likely incomplete. Retrying instead of using partial content.`
    );
  }

  const toolUse = response.content.find((block: any) => block.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('[Generator][SingleCall] Model did not return the expected tool call.');
  }

  const raw = toolUse.input as {
    passage_intro?: string | null;
    passage?: string | null;
    stimulus?: string | null;
    question_text: string;
    correct_answer: string;
    choices: Array<{ choice_text: string; is_correct: boolean; rationale: string }>;
    solution: { step_by_step: string; explanation: string };
    verification?: {
      equation_lhs: string;
      equation_rhs: string;
      variable: string | string[];
      variable_value: number | number[];
    } | null;
  };

  // Reshape the single merged response into the exact 3 objects the real,
  // exported assembleChoices() from generatorAgent.ts already expects —
  // this reuses the existing label-stripping / null-normalizing / dedup /
  // shuffle logic instead of duplicating it here.
  const draft = {
    passage: raw.passage ?? null,
    stimulus: raw.stimulus ?? null,
    question_text: raw.question_text,
  };

  const solved = {
    exact_computed_answer: raw.correct_answer,
    step_by_step_solution: raw.solution.step_by_step,
    explanation: raw.solution.explanation,
    verification: raw.verification ?? undefined,
  };

  const wrong = {
    distractors: raw.choices
      .filter((c) => !c.is_correct)
      .map((c) => ({ choice_text: c.choice_text, rationale: c.rationale })),
  };

  const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const question = assembleChoices(
    draft,
    solved,
    wrong,
    {
      subject: params.subject,
      domain: params.domain,
      skill: params.skill,
      difficulty: params.difficulty,
      examType: params.examType,
    },
    uniqueSuffix
  );

  await params.onStep?.({
    timestamp: new Date().toISOString(),
    type: 'finalize',
    message: `Generator Agent (single-call): Question generated successfully. ID: ${question.question_id}`,
  });

  return question;
}

/**
 * Batch-shaped wrapper matching runGeneratorAgent()'s { questions: Question[] }
 * return shape, so pipeline.ts can switch between the two code paths with a
 * minimal call-site change. Runs each question sequentially (single-call
 * generation is already cheap — one Claude call per question — so there is
 * no chunk/parallel-draft machinery to replicate here).
 */
export async function runGeneratorAgentSingleCall(params: {
  subject: string;
  domain: string;
  skill: string;
  difficulty: string;
  studentLevel?: string;
  examType?: string;
  onStep?: (log: PipelineStepLog) => void | Promise<void>;
  feedback?: string;
  count?: number;
  logTag?: string;
}): Promise<{ questions: Question[] }> {
  const {
    subject, domain, skill, difficulty, studentLevel,
    examType = 'SAT',
    onStep,
    feedback,
    count = 1,
    logTag,
  } = params;

  const questions: Question[] = [];
  const errors: string[] = [];

  for (let i = 0; i < count; i++) {
    try {
      const q = await generateQuestionSingleCall({
        subject, examType, domain, skill, difficulty, studentLevel, feedback, onStep, logTag,
      });
      questions.push(q);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`Question ${i + 1} failed: ${msg}`);
      await onStep?.({
        timestamp: new Date().toISOString(),
        type: 'draft',
        message: `Generator Agent (single-call): Question ${i + 1}/${count} failed — ${msg}`,
      });
    }
  }

  if (questions.length === 0) {
    throw new Error(`Single-call batch generation failed for all questions: ${errors.join(' | ')}`);
  }

  return { questions };
}
