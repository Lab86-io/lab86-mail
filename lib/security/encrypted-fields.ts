// Every Convex table field that holds encryptSecret output. The key rotation
// script (scripts/rotate-encryption-key.ts) and the Convex rotation functions
// (convex/encryptionRotation.ts) read and write only these fields.
//
// tests/encryption-key-rotation.test.ts fails when convex/schema.ts gets a
// field whose name says it is encrypted and the field is not listed here.
// When you add an encrypted field, add it here in the same change.

export interface EncryptedField {
  table: string;
  // The field path in the document. A nested path names a field inside an
  // optional object (for example officeDocuments.google.session).
  path: readonly string[];
  // What the value holds, for the operator report.
  holds: string;
}

export const ENCRYPTED_FIELDS: readonly EncryptedField[] = [
  { table: 'providerGrants', path: ['accessTokenEncrypted'], holds: 'Mailbox access token' },
  { table: 'providerGrants', path: ['refreshTokenEncrypted'], holds: 'Mailbox refresh token' },
  { table: 'aiProviderKeys', path: ['encryptedKey'], holds: 'User model provider key' },
  { table: 'cloudFileCredentials', path: ['accessTokenEncrypted'], holds: 'File provider access token' },
  { table: 'cloudFileCredentials', path: ['refreshTokenEncrypted'], holds: 'File provider refresh token' },
  { table: 'cloudFileOAuthStates', path: ['codeVerifierEncrypted'], holds: 'PKCE verifier (minutes)' },
  {
    table: 'cloudFileOAuthCompletions',
    path: ['authorizationCodeEncrypted'],
    holds: 'Authorization code (minutes)',
  },
  { table: 'cloudFileOAuthCompletions', path: ['codeVerifierEncrypted'], holds: 'PKCE verifier (minutes)' },
  { table: 'oauthCompletions', path: ['payloadEncrypted'], holds: 'Authorization code (minutes)' },
  { table: 'mcpCredentials', path: ['accessTokenEncrypted'], holds: 'Tool access token' },
  { table: 'mcpCredentials', path: ['refreshTokenEncrypted'], holds: 'Tool refresh token' },
  {
    table: 'mcpCredentials',
    path: ['oauthClientInformationEncrypted'],
    holds: 'Tool OAuth client registration',
  },
  { table: 'mcpOAuthStates', path: ['payloadEncrypted'], holds: 'Tool OAuth transaction (minutes)' },
  { table: 'officeDocuments', path: ['google', 'session'], holds: 'Google working copy session' },
  {
    table: 'officeDocuments',
    path: ['google', 'pendingSave', 'session'],
    holds: 'Google working copy session (pending save)',
  },
];

export function encryptedFieldKey(field: Pick<EncryptedField, 'table' | 'path'>) {
  return `${field.table}.${field.path.join('.')}`;
}

export function isEncryptedField(table: string, path: readonly string[]) {
  const key = encryptedFieldKey({ table, path });
  return ENCRYPTED_FIELDS.some((field) => encryptedFieldKey(field) === key);
}

export function encryptedTables() {
  return [...new Set(ENCRYPTED_FIELDS.map((field) => field.table))];
}

export function encryptedFieldsFor(table: string) {
  return ENCRYPTED_FIELDS.filter((field) => field.table === table);
}

/** The string at `path` in a document, or undefined. */
export function readEncryptedValue(document: unknown, path: readonly string[]): string | undefined {
  let value: unknown = document;
  for (const segment of path) {
    if (!value || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return typeof value === 'string' ? value : undefined;
}

/**
 * The top-level patch that sets `path` to `next`. A nested path copies each
 * parent object, so the other fields in it stay as they are.
 */
export function patchForEncryptedValue(
  document: Record<string, unknown>,
  path: readonly string[],
  next: string,
): Record<string, unknown> {
  const [head, ...rest] = path;
  if (rest.length === 0) return { [head]: next };
  const parent = (document[head] ?? {}) as Record<string, unknown>;
  return { [head]: { ...parent, ...patchForEncryptedValue(parent, rest, next) } };
}
