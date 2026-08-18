import { generateTextForCurrentUser } from '../ai/gateway';
import { api, convexMutation, convexQuery } from '../hosted/convex';
import { advanceWork } from './work-orchestrator';

// The chat agent satisfies the user directly; the Work document holds the
// durable truth. This module is the deterministic bridge between them: after
// EVERY agent turn that ran with a Work attached, the server — not the model —
// records chat-created artifacts on the Work, resolves open questions the
// conversation answered, and replans. The model's own albatross_* calls remain
// the fast path; this reconcile is the loop that always closes.

interface WorkTurnReconcileDependencies {
  convexQuery: typeof convexQuery;
  convexMutation: typeof convexMutation;
  generateTextForCurrentUser: typeof generateTextForCurrentUser;
  advanceWork: typeof advanceWork;
  reportError: (message: string, ...rest: unknown[]) => void;
}

const defaultDependencies: WorkTurnReconcileDependencies = {
  convexQuery,
  convexMutation,
  generateTextForCurrentUser,
  advanceWork,
  reportError: console.warn,
};

let dependencies = defaultDependencies;

export function setWorkTurnReconcileDependenciesForTest(overrides: Partial<WorkTurnReconcileDependencies>) {
  const previous = dependencies;
  dependencies = { ...previous, ...overrides };
  return () => {
    dependencies = previous;
  };
}

export interface TurnToolCall {
  toolName: string;
  input: any;
  output: any;
  ok: boolean;
}

/** Pair each tool call in a finished generation with its result by call id. */
export function toolCallsFromSteps(steps: any[]): TurnToolCall[] {
  const calls = new Map<string, TurnToolCall>();
  const order: string[] = [];
  for (const step of steps || []) {
    for (const part of step?.content || []) {
      if (part?.type === 'tool-call' && part.toolCallId) {
        calls.set(part.toolCallId, {
          toolName: String(part.toolName || ''),
          input: part.input,
          output: undefined,
          ok: false,
        });
        order.push(part.toolCallId);
      } else if (part?.type === 'tool-result' && calls.has(part.toolCallId)) {
        const call = calls.get(part.toolCallId)!;
        call.output = part.output;
        call.ok = part.output?.ok !== false;
      } else if (part?.type === 'tool-error' && calls.has(part.toolCallId)) {
        calls.get(part.toolCallId)!.ok = false;
      }
    }
  }
  return order.map((id) => calls.get(id)!).filter((call) => call.toolName);
}

export interface TurnArtifact {
  kind: 'calendarEvent' | 'task' | 'document';
  id: string;
  title: string;
  operationId?: string;
  sourceKind: 'calendar_event' | 'task' | 'manual';
}

/** Artifacts the chat created directly, outside the plan-apply pipeline. */
export function harvestTurnArtifacts(calls: TurnToolCall[]): TurnArtifact[] {
  const artifacts: TurnArtifact[] = [];
  for (const call of calls) {
    if (!call.ok || !call.output) continue;
    const title = String(call.input?.title || '').slice(0, 300);
    if (call.toolName === 'calendar_create_event' && call.output.eventId) {
      artifacts.push({
        kind: 'calendarEvent',
        id: String(call.output.eventId),
        title: title || 'Calendar event',
        operationId: call.output.operationId ? String(call.output.operationId) : undefined,
        sourceKind: 'calendar_event',
      });
    } else if (call.toolName === 'tasks_create_card' && call.output.cardId) {
      artifacts.push({
        kind: 'task',
        id: String(call.output.cardId),
        title: title || 'Task',
        operationId: call.output.operationId ? String(call.output.operationId) : undefined,
        sourceKind: 'task',
      });
    } else if (call.toolName === 'document_create' && call.output.documentId) {
      artifacts.push({
        kind: 'document',
        id: String(call.output.documentId),
        title: title || 'Document',
        sourceKind: 'manual',
      });
    }
  }
  return artifacts;
}

export interface TurnSignals {
  recordedProgress: boolean;
  progressClaims: string[];
  answersViaTool: number;
  replanSucceeded: boolean;
}

/** What the model already did on the Work this turn, so the reconcile does not repeat it. */
export function turnSignals(calls: TurnToolCall[]): TurnSignals {
  const signals: TurnSignals = {
    recordedProgress: false,
    progressClaims: [],
    answersViaTool: 0,
    replanSucceeded: false,
  };
  for (const call of calls) {
    if (!call.ok) continue;
    if (call.toolName === 'albatross_record_progress') {
      signals.recordedProgress = true;
      const claim = String(call.input?.claim || '').trim();
      if (claim) signals.progressClaims.push(claim.slice(0, 600));
      signals.answersViaTool += Array.isArray(call.input?.questionAnswers)
        ? call.input.questionAnswers.length
        : 0;
    } else if (call.toolName === 'albatross_replan_work') {
      signals.replanSucceeded = true;
    }
  }
  return signals;
}

const HITL_NAMES = new Set([
  'ask_user',
  'ask_approval',
  'ask_parameters',
  'ask_preferences',
  'ask_question_flow',
]);

function partToolName(part: any): string {
  const type = typeof part?.type === 'string' ? part.type : '';
  if (type === 'dynamic-tool') return typeof part?.toolName === 'string' ? part.toolName : '';
  return type.startsWith('tool-') ? type.slice(5) : '';
}

/**
 * A plain-text replay of the recent conversation, including the question-form
 * exchanges (ask_user and friends) whose answers never appear as user text.
 * This is what the question classifier reads.
 */
export function conversationExcerpt(messages: any[], maxMessages = 12, maxChars = 5_000): string {
  const lines: string[] = [];
  for (const message of (messages || []).slice(-maxMessages)) {
    const role = message?.role === 'user' ? 'User' : message?.role === 'assistant' ? 'Assistant' : '';
    if (!role) continue;
    for (const part of message?.parts || []) {
      if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        lines.push(`${role}: ${part.text.trim()}`);
        continue;
      }
      const toolName = partToolName(part);
      if (HITL_NAMES.has(toolName) && part?.output !== undefined) {
        const questions = Array.isArray(part?.input?.questions)
          ? part.input.questions.map((entry: any) => String(entry?.question || '')).filter(Boolean)
          : [];
        if (questions.length) lines.push(`Assistant asked: ${questions.join(' | ')}`);
        try {
          lines.push(`User answered: ${JSON.stringify(part.output)}`);
        } catch {
          // unserializable answer payload — the text lines still carry the turn
        }
      }
    }
  }
  let excerpt = lines.join('\n');
  if (excerpt.length > maxChars) excerpt = excerpt.slice(excerpt.length - maxChars);
  return excerpt;
}

interface ResolvedAnswer {
  questionId: string;
  answer: string;
}

const CLASSIFIER_SYSTEM = `You check whether a conversation answered open plan questions. Respond with ONE JSON object, no prose: {"answers": [{"questionId": string, "answer": string}]}.
Rules:
- Include a question ONLY when the conversation plainly and completely answers it.
- Compose each answer from the user's own statements: specific, factual, self-contained.
- Never invent, infer beyond the user's words, or pad. When nothing is answered, return {"answers": []}.`;

async function classifyAnsweredQuestions(input: {
  userId: string;
  userEmail?: string | null;
  userName?: string | null;
  pending: Array<{ _id: string; prompt: string }>;
  excerpt: string;
  claims: string[];
}): Promise<ResolvedAnswer[]> {
  const prompt = [
    'Open questions:',
    ...input.pending.map((question) => `- [${question._id}] ${question.prompt}`),
    '',
    input.claims.length
      ? `User-confirmed progress this turn:\n${input.claims.map((claim) => `- ${claim}`).join('\n')}\n`
      : '',
    'Conversation:',
    input.excerpt,
  ]
    .filter(Boolean)
    .join('\n');
  const { text } = await dependencies.generateTextForCurrentUser({
    feature: 'albatross_turn_reconcile',
    speed: 'fast',
    userId: input.userId,
    userEmail: input.userEmail,
    userName: input.userName,
    system: CLASSIFIER_SYSTEM,
    prompt: prompt.slice(0, 20_000),
  });
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return [];
  let parsed: any;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  const validIds = new Set(input.pending.map((question) => String(question._id)));
  const seen = new Set<string>();
  const answers: ResolvedAnswer[] = [];
  for (const entry of Array.isArray(parsed?.answers) ? parsed.answers : []) {
    const questionId = String(entry?.questionId || '');
    const answer = String(entry?.answer || '').trim();
    if (!validIds.has(questionId) || seen.has(questionId) || !answer) continue;
    seen.add(questionId);
    answers.push({ questionId, answer: answer.slice(0, 2_000) });
  }
  return answers;
}

export interface ReconcileWorkTurnInput {
  userId: string;
  userEmail?: string | null;
  userName?: string | null;
  workId: string;
  timezone?: string;
  /** Completed generation steps from the agent run (result.steps). */
  steps: any[];
  /** The UI messages the turn ran over, newest last. */
  uiMessages: any[];
}

export interface ReconcileWorkTurnResult {
  status: 'ok' | 'skipped' | 'error';
  artifactsRecorded: number;
  questionsAnswered: number;
  advanced: boolean;
}

export async function reconcileWorkTurn(input: ReconcileWorkTurnInput): Promise<ReconcileWorkTurnResult> {
  const skipped: ReconcileWorkTurnResult = {
    status: 'skipped',
    artifactsRecorded: 0,
    questionsAnswered: 0,
    advanced: false,
  };
  try {
    const calls = toolCallsFromSteps(input.steps);
    const signals = turnSignals(calls);
    const artifacts = harvestTurnArtifacts(calls);
    const detail = await dependencies.convexQuery<any>((api as any).albatrossWorkV2.workDetail, {
      userId: input.userId,
      workId: input.workId,
    });
    if (!detail?.work) return skipped;
    const workState = detail.work.workState || detail.work.status;
    if (['done', 'released', 'archived'].includes(workState)) return skipped;

    if (artifacts.length) {
      await dependencies.convexMutation((api as any).albatrossWork.appendPlanApplicationArtifacts, {
        userId: input.userId,
        intentId: input.workId,
        artifacts: artifacts.map(({ sourceKind: _sourceKind, ...artifact }) => artifact),
        operationIds: artifacts.map((artifact) => artifact.operationId || '').filter(Boolean),
      });
      for (const artifact of artifacts) {
        // settleContract: false — a chat-created hold is context for the
        // planner, never proof that the outcome itself happened.
        await dependencies.convexMutation((api as any).albatrossWorkV2.attachProof, {
          userId: input.userId,
          workId: input.workId,
          claim: `Created in chat for this Work: "${artifact.title}".`,
          title: artifact.title,
          summary: `Chat-created ${artifact.kind === 'calendarEvent' ? 'calendar event' : artifact.kind}. Do not propose it again.`,
          sourceKind: artifact.sourceKind,
          sourceId: artifact.id,
          trust: 'observed',
          settleContract: false,
        });
      }
    }

    const pending = (detail.questions || []).filter((question: any) => question.status === 'pending');
    let questionsAnswered = 0;
    let answersWantAdvance = false;
    if (pending.length) {
      const excerpt = conversationExcerpt(input.uiMessages);
      if (excerpt || signals.progressClaims.length) {
        const resolved = await classifyAnsweredQuestions({
          userId: input.userId,
          userEmail: input.userEmail,
          userName: input.userName,
          pending,
          excerpt,
          claims: signals.progressClaims,
        }).catch((error) => {
          dependencies.reportError('[work-turn-reconcile] question classifier failed', error);
          return [] as ResolvedAnswer[];
        });
        for (const answer of resolved) {
          const answered = await dependencies.convexMutation<{ shouldAdvance?: boolean }>(
            (api as any).albatrossWorkV2.answerQuestion,
            {
              userId: input.userId,
              questionId: answer.questionId,
              answer: answer.answer,
            },
          );
          questionsAnswered += 1;
          if (answered?.shouldAdvance) answersWantAdvance = true;
        }
      }
    }

    const evidenceTouched = signals.recordedProgress || artifacts.length > 0;
    // An answered completion question can close the Work outright; only a
    // clarification-style answer (shouldAdvance) forces the replan.
    const advanced = answersWantAdvance || (evidenceTouched && !signals.replanSucceeded);
    if (advanced) {
      const fresh = await dependencies.convexQuery<any>((api as any).albatrossWorkV2.workDetail, {
        userId: input.userId,
        workId: input.workId,
      });
      const freshState = fresh?.work?.workState || fresh?.work?.status;
      // An answered completion question may have closed the Work just now.
      if (['done', 'released', 'archived'].includes(freshState)) {
        return { status: 'ok', artifactsRecorded: artifacts.length, questionsAnswered, advanced: false };
      }
      const evidenceAt = fresh?.work?.lastEvidenceAt;
      await dependencies.advanceWork({
        userId: input.userId,
        userEmail: input.userEmail,
        userName: input.userName,
        workId: input.workId,
        timezone: input.timezone,
      });
      // Mark the evidence as reconciled so the cron does not replan again.
      if (typeof evidenceAt === 'number') {
        await dependencies
          .convexMutation((api as any).albatrossWorkV2.completeEvidenceReconcile, {
            userId: input.userId,
            workId: input.workId,
            evidenceAt,
          })
          .catch(() => undefined);
      }
    }
    return { status: 'ok', artifactsRecorded: artifacts.length, questionsAnswered, advanced };
  } catch (error) {
    dependencies.reportError('[work-turn-reconcile] failed', input.workId, error);
    return { ...skipped, status: 'error' };
  }
}
