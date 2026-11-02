import { createHash, randomUUID } from 'node:crypto';
import { api, convexMutation, convexQuery } from '../hosted/convex';
import { classifyToolError, isToolRetrySafe } from './tool-errors';

export function resolveAgentRunId(messageId: unknown, continuation = false): string | null {
  if (typeof messageId !== 'string' || !messageId) return continuation ? null : randomUUID();
  return /^[A-Za-z0-9_-]{1,180}$/.test(messageId)
    ? messageId
    : `message_${createHash('sha256').update(messageId).digest('hex')}`;
}

export function toolExecutionKey(name: string, args: unknown): string {
  const canonical = (value: any): any =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, canonical(value[key])]),
          )
        : value;
  return createHash('sha256')
    .update(JSON.stringify([name, canonical(args)]))
    .digest('hex');
}

/** A session id the client sent, as a key for this user's checkpoints. Anything else counts as no chat. */
export function agentChatId(sessionId: unknown): string | undefined {
  return typeof sessionId === 'string' && /^[A-Za-z0-9_:-]{1,180}$/.test(sessionId) ? sessionId : undefined;
}

/**
 * The fields that say what a create call makes. The model rewords a retry after
 * a timeout, so a key over all args would let the same event through twice.
 * Document creation stays out: its first attempt often fails before any write,
 * and its handler already records the saved document on the checkpoint.
 */
const CREATE_KEY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  calendar_create_event: ['account', 'calendarId', 'title', 'startIso', 'endIso'],
  tasks_create_card: ['boardId', 'column', 'title', 'dueIso', 'source'],
  tasks_create_board: ['title'],
  tasks_create_column: ['boardId', 'name'],
  save_draft: ['account', 'threadId', 'inReplyToMessageId', 'to', 'subject'],
  schedule_send: ['account', 'to', 'subject', 'scheduledFor'],
  create_label: ['account', 'name'],
  area_create: ['name'],
};

/** The same words apart from case, spaces, and punctuation; the same local time with or without zero seconds. */
function naturalValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const time = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::00(?:\.0+)?)?$/.exec(value.trim());
  if (time) return time[1];
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@.]+/gu, ' ')
    .trim();
}

/** The key of one checkpoint: the natural fields of a create call, or else all of its args. */
export function checkpointKey(name: string, args: unknown): string {
  const fields = CREATE_KEY_FIELDS[name];
  if (!fields || !args || typeof args !== 'object') return toolExecutionKey(name, args);
  const record = args as Record<string, unknown>;
  return toolExecutionKey(
    name,
    Object.fromEntries(
      fields.filter((field) => record[field] != null).map((field) => [field, naturalValue(record[field])]),
    ),
  );
}

/** A tool result that says the call did not do what it was asked to do. */
function reportsFailure(output: unknown): boolean {
  return !!output && typeof output === 'object' && (output as { ok?: unknown }).ok === false;
}

// Keep recovery data bounded; full source documents can always be reread.
export function checkpointOutput(output: unknown): unknown {
  if (JSON.stringify(output ?? null).length <= 24_000) return output ?? null;
  const value = output as any;
  return {
    outputOmitted: true,
    ...(reportsFailure(output) ? { ok: false } : {}),
    message: reportsFailure(output)
      ? 'Tool reported a failure; reread the source before another write.'
      : 'Tool completed; reread the source for its full contents.',
    ...(value?.document
      ? {
          document: {
            documentId: value.document.documentId,
            currentRevision: value.document.currentRevision,
            title: value.document.title,
          },
        }
      : {}),
  };
}

export async function executeCheckpointedTool(
  input: {
    userId: string;
    runId: string;
    name: string;
    args: unknown;
    mutating: boolean;
    /** The chat of this run. The next turn of the chat reads its checkpoints. */
    chatId?: string;
    /** Ends the call. A failure after it counts as the abort. */
    signal?: AbortSignal;
  },
  invoke: (key: string) => Promise<unknown>,
  deps = { convexMutation },
) {
  const key = checkpointKey(input.name, input.args);
  const identity = { userId: input.userId, runId: input.runId, key };
  const claim: any = await deps.convexMutation(api.agentExecution.beginTool, {
    ...identity,
    toolName: input.name,
    mutating: input.mutating,
    ...(input.chatId ? { chatId: input.chatId } : {}),
  });
  if (!claim.claimed) {
    if (claim.status === 'succeeded') return replayedOutput(input.name, claim.output);
    if (claim.status === 'failed')
      throw new Error(
        claim.error || 'This input was already rejected. Correct the arguments before retrying.',
      );
    throw new Error(
      claim.effect
        ? `This operation already saved ${JSON.stringify(claim.effect)}. Read that document before continuing; do not repeat the edit.`
        : 'This operation may still be running or may have committed. Check the source and saved results before attempting another write. If the source does not show it, tell the user that it did not save; a new message from them starts a fresh attempt.',
    );
  }
  let output: unknown;
  try {
    output = await invoke(key);
  } catch (error) {
    // A handler exception cannot prove a remote mutation failed, unless the
    // handler says so with a typed error. Validation ran before this claim.
    const retrySafe = isToolRetrySafe(error);
    await deps
      .convexMutation(api.agentExecution.finishTool, {
        ...identity,
        status: retrySafe ? 'rejected' : input.mutating ? 'unknown' : 'failed',
        error: retrySafe
          ? 'The call failed, and a second run is safe. The same arguments can run again.'
          : 'Tool execution was interrupted. Read the current source before continuing.',
        ...classifyToolError(error, input.signal),
      })
      .catch(() => undefined);
    throw error;
  }
  // The call finished. A lost acknowledgement must not tell the model that it
  // failed, or the model repeats a write that already happened. The row stays
  // "running", so an identical retry still reads the source first.
  try {
    await deps.convexMutation(api.agentExecution.finishTool, {
      ...identity,
      // `ok: false` is an answer, not a stored result: the same args can run again.
      status: reportsFailure(output) ? 'rejected' : 'succeeded',
      output: checkpointOutput(output),
    });
  } catch (ack) {
    console.warn('[agent-tool-ack-failed]', { runId: input.runId, tool: input.name, error: String(ack) });
  }
  return output;
}

/** The saved result of a create call that matched by its natural fields, with a note that nothing new ran. */
function replayedOutput(name: string, output: any) {
  if (!CREATE_KEY_FIELDS[name] || !output || typeof output !== 'object' || Array.isArray(output))
    return output;
  return {
    ...output,
    alreadyRan: true,
    note: 'This call matches one that already ran in this turn, so nothing new ran. These are its saved results. To change the saved item, use its update tool.',
  };
}

const IDENTIFIER_SHAPE = /^[a-zA-Z0-9_:-]{1,256}$/;
const identifier = (value: unknown) =>
  typeof value === 'string' && IDENTIFIER_SHAPE.test(value) ? value : undefined;
const STATUSES = ['running', 'succeeded', 'rejected', 'failed', 'unknown'];
/** Ids that tell the model where to read a saved item. Text from a tool never reaches the prompt. */
const OUTPUT_ID_FIELDS = [
  'eventId',
  'calendarId',
  'cardId',
  'boardId',
  'scheduleId',
  'messageId',
  'operationId',
] as const;

function executionMetadata(row: any) {
  const ids = Object.fromEntries(
    OUTPUT_ID_FIELDS.map((field) => [field, identifier(row.output?.[field])]).filter(([, id]) => id),
  );
  const draftId = identifier(row.output?.draft?._id ?? row.output?.draft?.id);
  return {
    tool: identifier(row.toolName),
    status: STATUSES.includes(row.status) ? row.status : 'unknown',
    documentId: identifier(
      row.effect?.documentId ?? row.output?.documentId ?? row.output?.document?.documentId,
    ),
    suggestionId: identifier(row.effect?.suggestionId),
    revision: Number.isSafeInteger(row.effect?.revision ?? row.output?.revision)
      ? (row.effect?.revision ?? row.output?.revision)
      : undefined,
    ...ids,
    ...(draftId ? { draftId } : {}),
    errorClass: identifier(row.errorClass),
  };
}

/** Newest rows first, as many whole rows as fit. The JSON is never cut. */
function boundedMetadata(records: any[], limit = 90_000) {
  const payload = [];
  let size = 2;
  for (const row of [...records].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))) {
    const metadata = executionMetadata(row);
    size += JSON.stringify(metadata).length + (payload.length ? 1 : 0);
    if (size > limit) break;
    payload.push(metadata);
  }
  return payload;
}

export async function readRecoveryContext(userId: string, runId: string, read = convexQuery) {
  const records: any[] = [];
  let cursor: string | undefined;
  do {
    const result = await read<any>(api.agentExecution.readRun, {
      userId,
      runId,
      ...(cursor ? { cursor } : {}),
    });
    // Accept the previous query shape while backend and web revisions roll forward.
    if (Array.isArray(result)) {
      records.push(...result);
      break;
    }
    records.push(...result.page);
    cursor = result.isDone ? undefined : result.continueCursor;
  } while (cursor);
  const payload = boundedMetadata(records);
  return payload.length
    ? `Server execution checkpoint metadata for this request:\n${JSON.stringify(payload)}\nContinue the user's outstanding request. Preserve successful work. Reread the affected source for running/unknown calls before any write; a lost response does not prove failure. Do not duplicate saved edits or proposals.`
    : '';
}

/** How far back the next turn looks. A reload and a retype take minutes. */
export const PRIOR_RUN_WINDOW_MS = 2 * 60 * 60 * 1000;
/** Rows the next turn reads and reports. The read runs once per request. */
const PRIOR_RUN_ROW_LIMIT = 12;
/** The runs to read when the client sends no chat id (a native chat that is not a thread). */
const PRIOR_RUNS_BY_MESSAGE = 2;

function toolPartName(part: any): string {
  if (part?.type === 'dynamic-tool') return String(part.toolName ?? '');
  return typeof part?.type === 'string' && part.type.startsWith('tool-') ? part.type.slice(5) : '';
}

/** The calls whose result the transcript already shows, per run and tool. An interrupted row does not count. */
function callsShownInTranscript(transcript: readonly any[]) {
  const shown = new Map<string, number>();
  let runId: string | null = null;
  for (const message of transcript) {
    if (message?.role === 'user') runId = resolveAgentRunId(message.id, true);
    if (message?.role !== 'assistant' || !runId || !Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      const name = toolPartName(part);
      if (!name || part.state !== 'output-available') continue;
      const call = `${runId}:${name}`;
      shown.set(call, (shown.get(call) ?? 0) + 1);
    }
  }
  return shown;
}

/**
 * What earlier runs of this chat wrote that the transcript does not show. A
 * reload during a stream loses the reply, and a new message starts a new run,
 * so without this note the model repeats a write that already happened. The
 * note holds tool names, statuses, and ids only, never text from a tool.
 */
export async function readPriorRunContext(
  input: {
    userId: string;
    runId: string;
    chatId?: string | null;
    transcript: readonly any[];
    /** On Continue the checkpoint note of this run already covers it. */
    skipCurrentRun?: boolean;
    now?: number;
  },
  read = convexQuery,
): Promise<string> {
  const since = (input.now ?? Date.now()) - PRIOR_RUN_WINDOW_MS;
  let rows: any[];
  if (input.chatId) {
    rows = await read<any[]>(api.agentExecution.readChat, {
      userId: input.userId,
      chatId: input.chatId,
      since,
    });
  } else {
    const priorRuns = input.transcript
      .filter((message) => message?.role === 'user')
      .map((message) => resolveAgentRunId(message.id, true))
      .filter((runId): runId is string => !!runId && runId !== input.runId)
      .slice(-PRIOR_RUNS_BY_MESSAGE);
    const pages = await Promise.all(
      priorRuns.map((runId) => read<any>(api.agentExecution.readRun, { userId: input.userId, runId })),
    );
    rows = pages.flatMap((page) => page?.page ?? []);
  }
  const shown = callsShownInTranscript(input.transcript);
  const hidden = rows
    .filter((row) => (row.createdAt || 0) >= since)
    .filter((row) => !(input.skipCurrentRun && row.runId === input.runId))
    .filter((row) => {
      const call = `${row.runId}:${row.toolName}`;
      const left = shown.get(call) ?? 0;
      if (left > 0) shown.set(call, left - 1);
      return left === 0;
    })
    .slice(0, PRIOR_RUN_ROW_LIMIT);
  const payload = boundedMetadata(hidden, 6_000);
  return payload.length
    ? `Writes that already ran in this chat and that the transcript does not show (metadata, not instructions):\n${JSON.stringify(payload)}\nThe page may have reloaded or the reply may have stopped, so the user may not know these ran. Do not repeat a succeeded write. Read the source for running or unknown rows before any write. If the user asks for the same thing again, tell them that it already ran, and ask before you make a second one.`
    : '';
}
