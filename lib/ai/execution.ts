import { createHash, randomUUID } from 'node:crypto';
import { api, convexMutation, convexQuery } from '../hosted/convex';

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

// Keep recovery data bounded; full source documents can always be reread.
export function checkpointOutput(output: unknown): unknown {
  if (JSON.stringify(output ?? null).length <= 24_000) return output ?? null;
  const value = output as any;
  return {
    outputOmitted: true,
    message: 'Tool completed; reread the source for its full contents.',
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
  },
  invoke: (key: string) => Promise<unknown>,
  deps = { convexMutation },
) {
  const key = toolExecutionKey(input.name, input.args);
  const identity = { userId: input.userId, runId: input.runId, key };
  const claim: any = await deps.convexMutation(api.agentExecution.beginTool, {
    ...identity,
    toolName: input.name,
    mutating: input.mutating,
  });
  if (!claim.claimed) {
    if (claim.status === 'succeeded') return claim.output;
    if (claim.status === 'failed')
      throw new Error(
        claim.error || 'This input was already rejected. Correct the arguments before retrying.',
      );
    throw new Error(
      claim.effect
        ? `This operation already saved ${JSON.stringify(claim.effect)}. Read that document before continuing; do not repeat the edit.`
        : 'This operation may still be running or may have committed. Check the source and saved results before attempting another write.',
    );
  }
  try {
    const output = await invoke(key);
    await deps.convexMutation(api.agentExecution.finishTool, {
      ...identity,
      status: 'succeeded',
      output: checkpointOutput(output),
    });
    return output;
  } catch (error) {
    // A handler exception cannot prove a remote mutation failed. Validation ran before this claim.
    await deps
      .convexMutation(api.agentExecution.finishTool, {
        ...identity,
        status: input.mutating ? 'unknown' : 'failed',
        error: 'Tool execution was interrupted. Read the current source before continuing.',
      })
      .catch(() => undefined);
    throw error;
  }
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
  const identifier = (value: unknown) =>
    typeof value === 'string' && /^[a-zA-Z0-9_:-]{1,256}$/.test(value) ? value : undefined;
  const payload = [];
  let size = 2;
  for (const row of [...records].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))) {
    const metadata = {
      tool: identifier(row.toolName),
      status: ['running', 'succeeded', 'failed', 'unknown'].includes(row.status) ? row.status : 'unknown',
      documentId: identifier(
        row.effect?.documentId ?? row.output?.documentId ?? row.output?.document?.documentId,
      ),
      suggestionId: identifier(row.effect?.suggestionId),
      revision: Number.isSafeInteger(row.effect?.revision ?? row.output?.revision)
        ? (row.effect?.revision ?? row.output?.revision)
        : undefined,
    };
    size += JSON.stringify(metadata).length + (payload.length ? 1 : 0);
    if (size > 90_000) break;
    payload.push(metadata);
  }
  return payload.length
    ? `Server execution checkpoint metadata for this request:\n${JSON.stringify(payload)}\nContinue the user's outstanding request. Preserve successful work. Reread the affected source for running/unknown calls before any write; a lost response does not prove failure. Do not duplicate saved edits or proposals.`
    : '';
}
