import type { AlbatrossConfirmationRef } from '@/convex/albatrossModel';

export interface AreaMailListRow {
  providerThreadId: string;
  accountId: string;
  subject: string;
  fromAddress: string;
  lastDate: number;
  snippet: string;
  unread: boolean;
}

export function areaMailRowKey(row: Pick<AreaMailListRow, 'accountId' | 'providerThreadId'>) {
  return `${row.accountId}:${row.providerThreadId}`;
}

export function filterAreaMailRows<T extends AreaMailListRow>(
  rows: T[],
  input: { query?: string; unreadOnly?: boolean },
) {
  const query = (input.query || '').trim().toLowerCase();
  return rows.filter((row) => {
    if (input.unreadOnly && !row.unread) return false;
    if (!query) return true;
    return `${row.fromAddress} ${row.subject} ${row.snippet}`.toLowerCase().includes(query);
  });
}

export function selectedVisibleAreaMailRows<T extends AreaMailListRow>(rows: T[], selectedKeys: string[]) {
  const selected = new Set(selectedKeys);
  return rows.filter((row) => selected.has(areaMailRowKey(row)));
}

export function areaMailMoveReason(sourceAreaName: string, destinationAreaName: string) {
  return `Moved by the user from ${sourceAreaName} to ${destinationAreaName}.`;
}

export function areaMailMoveConfirmation(input: {
  sourceAreaId: string;
  destinationAreaId: string;
  accountId: string;
  threadId: string;
  sourceAreaName: string;
  destinationAreaName: string;
  confirmedAt: number;
  confirmedBy: string;
}): AlbatrossConfirmationRef {
  const identity = [
    String(input.confirmedAt),
    input.sourceAreaId,
    input.destinationAreaId,
    input.accountId,
    input.threadId,
  ].join(':');
  return {
    kind: 'userConfirmation',
    id: `area-mail-move:${identity}`,
    confirmedAt: input.confirmedAt,
    confirmedBy: input.confirmedBy,
    prompt: `Move this mail thread from ${input.sourceAreaName} to ${input.destinationAreaName}.`,
    sourceRefId: input.threadId,
  };
}
