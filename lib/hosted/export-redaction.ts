// What "Export my data" leaves out of each row. Pure: the Convex export
// query runs it, so a secret never leaves Convex.
//
// The export is the user's copy of what Albatross keeps about them. Live
// credentials (OAuth tokens, encrypted keys, push tokens, one-time codes,
// sign-in state) are not the user's content and would be dangerous in a
// downloaded file, so they are replaced with REDACTED. Derived search data
// (embeddings, search text) and mail bodies (the provider keeps the original)
// are dropped to keep the file readable.

export const REDACTED = '[removed from export]';

/** Fields removed in every table, at any depth. */
const SECRET_KEY =
  /Encrypted$|^encrypted|secret|password|^(token|completionToken|consumeToken|publicToken|p256dh)$/i;
const DERIVED_KEY = /^(embedding|searchText)$/;

/** Fields removed in one table only: the name alone is not a secret elsewhere. */
const TABLE_SECRETS: Record<string, readonly string[]> = {
  mailOneTimeCodes: ['code'],
  nylasOAuthStates: ['state'],
  mcpOAuthStates: ['state'],
  cloudFileOAuthStates: ['state'],
  officeSessions: ['key'],
  webPushSubscriptions: ['endpoint', 'auth'],
  albatrossBrowserSessions: ['liveViewUrl'],
};

/** Fields dropped in one table to keep the export a readable size. */
const TABLE_DROPS: Record<string, readonly string[]> = {
  // Mail bodies stay with the mail provider, which holds the original.
  mailCorpusMessages: ['textBody', 'htmlBody'],
};

function clean(value: unknown, depth: number): unknown {
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => clean(entry, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (DERIVED_KEY.test(key)) continue;
    out[key] = SECRET_KEY.test(key) ? REDACTED : clean(entry, depth + 1);
  }
  return out;
}

export function redactExportRow(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const out = clean(row, 0) as Record<string, unknown>;
  for (const key of TABLE_SECRETS[table] ?? []) if (key in out) out[key] = REDACTED;
  for (const key of TABLE_DROPS[table] ?? []) delete out[key];
  return out;
}

/**
 * Rows per first try. Tables with large rows read fewer at a time; the
 * exporter halves a page that is still too large (lib/hosted/data-export.ts).
 */
export function exportPageSize(table: string): number {
  switch (table) {
    case 'documentModels':
      return 2;
    case 'documents':
    case 'contentItems':
    case 'officeDocuments':
    case 'userDocs':
    case 'albatrossAreaBriefs':
      return 10;
    case 'briefPreparations':
    case 'narrativeEntries':
    case 'albatrossIntents':
    case 'albatrossIntentPlans':
    case 'albatrossEvidence':
      return 50;
    default:
      return 100;
  }
}
