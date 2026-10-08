import type { SecureKeyring } from './crypto';
import { rewrapDataKey, secureKeyring } from './crypto';

// Re-wraps every item's data key under the current secure KEK
// (docs/albatross-secure-store.md). The payloads do not change: only the small
// wrapped key does. A row is replaced only when it still holds the key that
// was read (compare and set), so a concurrent save always wins. The report
// holds counts only, never a value.

export interface SecureRotationRow {
  id: string;
  userId: string;
  itemId: string;
  kind: string;
  dataKeyWrapped: string;
  kekId: string;
}

export interface SecureRotationStore {
  listPage(input: {
    cursor: string | null;
    numItems: number;
  }): Promise<{ rows: SecureRotationRow[]; continueCursor: string; isDone: boolean }>;
  rewrap(input: { id: string; expected: string; dataKeyWrapped: string; kekId: string }): Promise<{
    replaced: boolean;
  }>;
}

export interface SecureRotationReport {
  apply: boolean;
  currentKeyId: string;
  total: number;
  current: number;
  byKeyId: Record<string, number>;
  /** Rows whose data key no configured KEK opens. Keep the old KEK in LAB86_SECURE_KEKS. */
  unopened: number;
  rewrapped: number;
  skipped: number;
}

export async function rotateSecureKek(
  store: SecureRotationStore,
  options: { apply: boolean; pageSize?: number },
  keyring: SecureKeyring | null = secureKeyring(),
): Promise<SecureRotationReport> {
  if (!keyring) throw new Error('LAB86_SECURE_KEK is not set.');
  const report: SecureRotationReport = {
    apply: options.apply,
    currentKeyId: keyring.currentKeyId,
    total: 0,
    current: 0,
    byKeyId: {},
    unopened: 0,
    rewrapped: 0,
    skipped: 0,
  };
  let cursor: string | null = null;
  for (;;) {
    const page = await store.listPage({ cursor, numItems: options.pageSize ?? 100 });
    for (const row of page.rows) {
      report.total += 1;
      report.byKeyId[row.kekId] = (report.byKeyId[row.kekId] ?? 0) + 1;
      if (row.kekId === keyring.currentKeyId) {
        report.current += 1;
        continue;
      }
      let next: ReturnType<typeof rewrapDataKey>;
      try {
        next = rewrapDataKey(
          { userId: row.userId, itemId: row.itemId, kind: row.kind },
          { payloadSealed: '', dataKeyWrapped: row.dataKeyWrapped, kekId: row.kekId },
          keyring,
        );
      } catch {
        report.unopened += 1;
        continue;
      }
      if (!options.apply) continue;
      const result = await store.rewrap({
        id: row.id,
        expected: row.dataKeyWrapped,
        dataKeyWrapped: next.dataKeyWrapped,
        kekId: next.kekId,
      });
      if (result.replaced) report.rewrapped += 1;
      else report.skipped += 1;
    }
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  return report;
}

export function formatSecureRotationReport(report: SecureRotationReport): string[] {
  return [
    `${report.apply ? 'Applied' : 'Dry run'}: current key "${report.currentKeyId}".`,
    `Items: ${report.total}. Already current: ${report.current}.`,
    `By key: ${
      Object.entries(report.byKeyId)
        .map(([id, count]) => `${id}=${count}`)
        .join(', ') || 'none'
    }.`,
    `Not opened: ${report.unopened}. Re-wrapped: ${report.rewrapped}. Skipped (changed after the read): ${report.skipped}.`,
  ];
}
