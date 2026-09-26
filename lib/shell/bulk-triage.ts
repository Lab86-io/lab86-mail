/**
 * The inbox bulk bar's triage run. The tool takes at most 40 threads, so a
 * larger selection is split into groups, and each group can fail alone.
 */
export const BULK_TRIAGE_CHUNK = 40;

export type BulkTriageItem = {
  id: string;
  account?: string;
  from?: string;
  subject?: string;
  snippet?: string;
};

export type BulkTriageResponse = { verdicts: unknown[]; model: string; saved?: number };

export type BulkTriageOutcome = {
  total: number;
  saved: number;
  failed: number;
  /** True when no model is set up, so no verdict was saved. */
  noModel: boolean;
  firstError: string | null;
};

export function chunk<T>(list: T[], size: number): T[][] {
  if (size < 1) throw new Error('chunk size must be positive');
  const groups: T[][] = [];
  for (let index = 0; index < list.length; index += size) groups.push(list.slice(index, index + size));
  return groups;
}

export async function runBulkTriage(
  items: BulkTriageItem[],
  call: (group: BulkTriageItem[]) => Promise<BulkTriageResponse>,
): Promise<BulkTriageOutcome> {
  const outcome: BulkTriageOutcome = {
    total: items.length,
    saved: 0,
    failed: 0,
    noModel: false,
    firstError: null,
  };
  for (const group of chunk(items, BULK_TRIAGE_CHUNK)) {
    try {
      const response = await call(group);
      if (response.model === 'local') {
        // The tool returns placeholder verdicts without a model. Do not send
        // the rest of the selection; nothing would be saved.
        outcome.noModel = true;
        return outcome;
      }
      outcome.saved += typeof response.saved === 'number' ? response.saved : 0;
    } catch (error) {
      outcome.failed += group.length;
      outcome.firstError ??= error instanceof Error ? error.message : String(error);
    }
  }
  return outcome;
}

export type BulkTriageMessage = { kind: 'success' | 'error' | 'info'; text: string };

export function bulkTriageMessage(outcome: BulkTriageOutcome): BulkTriageMessage {
  if (outcome.noModel)
    return { kind: 'info', text: 'Set up a model in Settings, Intelligence, to triage mail.' };
  if (outcome.failed === outcome.total)
    return {
      kind: 'error',
      text: `Could not triage ${outcome.total === 1 ? 'this thread' : 'these threads'}.`,
    };
  if (outcome.failed)
    return {
      kind: 'error',
      text: `Triaged ${outcome.total - outcome.failed} of ${outcome.total}. ${outcome.failed} could not be triaged.`,
    };
  return { kind: 'success', text: `Triaged ${outcome.total}` };
}
