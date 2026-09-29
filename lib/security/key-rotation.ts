import {
  decryptSecret,
  encryptedKeyId,
  encryptionKeyring,
  encryptionWriteFormat,
  needsReencryption,
  reencryptSecret,
} from './crypto';
import { ENCRYPTED_FIELDS, encryptedFieldKey, encryptedTables } from './encrypted-fields';

// Re-encrypts stored secrets under the current key. The store reads pages of
// encrypted values and replaces one value only when it still holds the value
// that was read (compare and set), so a concurrent write always wins.

export interface EncryptedValueRow {
  id: string;
  values: Array<{ path: string[]; value: string }>;
}

export interface RotationStore {
  listPage(input: {
    table: string;
    cursor: string | null;
    numItems: number;
  }): Promise<{ rows: EncryptedValueRow[]; continueCursor: string; isDone: boolean }>;
  replace(input: {
    table: string;
    id: string;
    path: string[];
    expected: string;
    next: string;
  }): Promise<{ replaced: boolean }>;
}

export interface FieldReport {
  // Stored values of this field.
  total: number;
  // Values that already use the write format and the current key.
  current: number;
  // Values by key id ("v1" is a value with no key id).
  byKeyId: Record<string, number>;
  // Values that no configured key opens. Keep their old key in the ring.
  undecryptable: number;
  // Apply mode only.
  reencrypted: number;
  // Apply mode only: the row changed or went away after the read.
  skipped: number;
}

export interface RotationReport {
  apply: boolean;
  currentKeyId: string;
  fields: Record<string, FieldReport>;
}

const defaultCrypto = {
  decryptSecret,
  encryptedKeyId,
  needsReencryption,
  reencryptSecret,
  currentKeyId: () => encryptionKeyring().currentKeyId,
};

function emptyReport(): FieldReport {
  return { total: 0, current: 0, byKeyId: {}, undecryptable: 0, reencrypted: 0, skipped: 0 };
}

/**
 * Stops a rotation run, a dry run too, while the v1 write format is set. With
 * that format every v1 value counts as current (it has no key id), so a dry
 * run would report no work while values still need a retired key. It reads
 * the format through encryptionWriteFormat, the same parser as the writes,
 * so " V1 " stops it too, and a value that is not a format throws.
 */
export function assertRotationWriteFormat(env: Record<string, string | undefined> = process.env) {
  if (encryptionWriteFormat(env) === 'v1') {
    throw new Error(
      'Unset LAB86_MAIL_ENCRYPTION_WRITE_FORMAT before a rotation or a dry run. v1 values have no key id.',
    );
  }
}

export async function rotateEncryptedFields(
  store: RotationStore,
  options: { apply: boolean; tables?: string[]; pageSize?: number },
  crypto: typeof defaultCrypto = defaultCrypto,
): Promise<RotationReport> {
  assertRotationWriteFormat();
  const known = encryptedTables();
  const tables = options.tables?.length ? options.tables : known;
  for (const table of tables) {
    if (!known.includes(table)) throw new Error(`Table ${table} holds no registered encrypted fields.`);
  }
  const report: RotationReport = { apply: options.apply, currentKeyId: crypto.currentKeyId(), fields: {} };
  for (const field of ENCRYPTED_FIELDS) {
    if (tables.includes(field.table)) report.fields[encryptedFieldKey(field)] = emptyReport();
  }

  for (const table of tables) {
    let cursor: string | null = null;
    for (;;) {
      const page = await store.listPage({ table, cursor, numItems: options.pageSize ?? 100 });
      for (const row of page.rows) {
        for (const { path, value } of row.values) {
          const entry = report.fields[encryptedFieldKey({ table, path })];
          if (!entry) continue;
          entry.total += 1;
          const kid = crypto.encryptedKeyId(value) ?? 'invalid';
          entry.byKeyId[kid] = (entry.byKeyId[kid] ?? 0) + 1;
          if (!crypto.needsReencryption(value)) {
            entry.current += 1;
            continue;
          }
          if (!options.apply) {
            try {
              crypto.decryptSecret(value);
            } catch {
              entry.undecryptable += 1;
            }
            continue;
          }
          let next: string;
          try {
            next = crypto.reencryptSecret(value).payload;
          } catch {
            entry.undecryptable += 1;
            continue;
          }
          const result = await store.replace({ table, id: row.id, path, expected: value, next });
          if (result.replaced) entry.reencrypted += 1;
          else entry.skipped += 1;
        }
      }
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
  }
  return report;
}

/** Plain-text lines for the operator. They hold counts only, never values. */
export function formatRotationReport(report: RotationReport) {
  const lines = [
    `${report.apply ? 'APPLY' : 'DRY RUN'}: current key id "${report.currentKeyId}"`,
    'field | total | current | by key id | undecryptable | re-encrypted | skipped',
  ];
  for (const [key, field] of Object.entries(report.fields)) {
    const byKey =
      Object.entries(field.byKeyId)
        .map(([kid, count]) => `${kid}=${count}`)
        .join(' ') || '-';
    lines.push(
      `${key} | ${field.total} | ${field.current} | ${byKey} | ${field.undecryptable} | ${field.reencrypted} | ${field.skipped}`,
    );
  }
  return lines;
}
