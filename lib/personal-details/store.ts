// Personal details: read, save, delete, and Undo (docs/albatross-thread.md).
//
// Convex holds only ciphertext (convex/personalDetails.ts). The sealed text is
// { u: userId, k: key, v: value }, so a value opens only for the row it was
// written for. Decryption happens here, in the Next server, for the
// signed-in user. Nothing in this file logs a value.

import {
  CUSTOM_DETAIL_PREFIX,
  type FixedPersonalDetailKey,
  isPersonalDetailKey,
  PERSONAL_DETAIL_KEYS,
  type PersonalDetailKey,
  type PersonalDetailSource,
  type PersonalDetailValue,
  type PersonalDetailView,
  personalDetailValueSchema,
} from '../albatross/thread-contract';
import { api, convexMutation, convexQuery } from '../hosted/convex';
import { decryptSecret, encryptSecret } from '../security/crypto';
import { detailDisplay, detailLabel, isCustomKey, nameFromAccount, phoneParts } from './format';
import { type Refusal, refuseDetail } from './policy';

export interface PersonalDetailsUser {
  userId: string;
  /** The account display name (Clerk). */
  name?: string | null;
  /** The account primary email. */
  email?: string | null;
}

type StoredSource = Exclude<PersonalDetailSource, 'account'>;

interface StoredRow {
  key: string;
  valueEncrypted: string;
  source: StoredSource;
  createdAt: number;
  updatedAt: number;
}

export interface PersonalDetailsDependencies {
  convexQuery: typeof convexQuery;
  convexMutation: typeof convexMutation;
  encrypt: (plaintext: string) => string;
  decrypt: (payload: string) => string;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}

const defaults: PersonalDetailsDependencies = {
  convexQuery,
  convexMutation,
  encrypt: encryptSecret,
  decrypt: decryptSecret,
  warn: (message, meta) => console.warn(message, meta),
};

export class PersonalDetailError extends Error {
  readonly code: 'invalid' | 'refused' | 'limit';
  readonly key: string;
  constructor(code: 'invalid' | 'refused' | 'limit', key: string, message: string) {
    super(message);
    this.name = 'PersonalDetailError';
    this.code = code;
    this.key = key;
  }
}

// ---------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------

export function sealDetail(
  userId: string,
  key: PersonalDetailKey,
  value: PersonalDetailValue,
  encrypt: (plaintext: string) => string = encryptSecret,
): string {
  return encrypt(JSON.stringify({ u: userId, k: key, v: value }));
}

/** The value of a sealed row, or null when it does not open or belongs to another row. */
export function openDetail(
  userId: string,
  key: string,
  sealed: string,
  decrypt: (payload: string) => string = decryptSecret,
): PersonalDetailValue | null {
  try {
    const parsed = JSON.parse(decrypt(sealed)) as { u?: unknown; k?: unknown; v?: unknown };
    if (parsed?.u !== userId || parsed?.k !== key || parsed.v === undefined) return null;
    return parsed.v as PersonalDetailValue;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

const US_REGIONS = new Set(
  'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR'.split(
    ' ',
  ),
);

/** A slug for a custom detail label: "Employer" → "custom:employer". */
export function customKeyFor(label: string): PersonalDetailKey | null {
  const slug = String(label || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  if (!slug || !/^[a-z0-9]/.test(slug)) return null;
  const key = `${CUSTOM_DETAIL_PREFIX}${slug}`;
  return isPersonalDetailKey(key) ? key : null;
}

/**
 * Check and normalize one value. A phone is stored as E.164 when it parses;
 * an address with a US state and no country gets "US"; a custom detail takes
 * a plain string with a label. Throws PersonalDetailError.
 */
export function parseDetailValue(
  key: PersonalDetailKey,
  raw: unknown,
  label?: string | null,
): PersonalDetailValue {
  let candidate: unknown = raw;
  if (isCustomKey(key)) {
    candidate =
      typeof raw === 'string'
        ? { label: label || detailLabel(key), value: raw }
        : { label: (raw as any)?.label || label || detailLabel(key), value: (raw as any)?.value };
  } else if (key === 'home_address' && raw && typeof raw === 'object' && !(raw as any).country) {
    const region = String((raw as any).region || '')
      .trim()
      .toUpperCase();
    if (US_REGIONS.has(region)) candidate = { ...(raw as object), region, country: 'US' };
  }
  const refusal: Refusal | null = refuseDetail({
    label: isCustomKey(key) ? (candidate as any)?.label : null,
    value: candidate,
  });
  if (refusal) throw new PersonalDetailError('refused', key, refusal.message);
  const parsed = personalDetailValueSchema(key).safeParse(candidate);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join('.') || '';
    throw new PersonalDetailError(
      'invalid',
      key,
      field
        ? `Check the ${field.replace(/([A-Z])/g, ' $1').toLowerCase()} of ${detailLabel(key)}.`
        : `Check ${detailLabel(key)}.`,
    );
  }
  if (key === 'phone') return phoneParts(parsed.data as string).e164 ?? (parsed.data as string);
  if (key === 'emergency_contact') {
    const contact = parsed.data as { phone: string };
    return {
      ...(parsed.data as object),
      phone: phoneParts(contact.phone).e164 ?? contact.phone,
    } as PersonalDetailValue;
  }
  return parsed.data;
}

function view(
  key: PersonalDetailKey,
  value: PersonalDetailValue,
  source: PersonalDetailSource,
  saved: boolean,
  updatedAt: number | null,
): PersonalDetailView {
  return {
    key,
    label: detailLabel(key, value),
    value,
    display: detailDisplay(key, value),
    source,
    saved,
    updatedAt,
  };
}

const KEY_ORDER = new Map<string, number>(PERSONAL_DETAIL_KEYS.map((key, index) => [key, index]));

function sortViews(views: PersonalDetailView[]): PersonalDetailView[] {
  return views.sort((a, b) => {
    const ai = KEY_ORDER.get(a.key) ?? 100;
    const bi = KEY_ORDER.get(b.key) ?? 100;
    return ai - bi || a.label.localeCompare(b.label);
  });
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Every detail of the user: the saved rows, then the account name and email
 * for keys that have no saved row. A row that does not open is left out (and
 * logged without its value), so one bad row never hides the others.
 */
export async function listPersonalDetails(
  user: PersonalDetailsUser,
  overrides: Partial<PersonalDetailsDependencies> = {},
): Promise<PersonalDetailView[]> {
  const deps = { ...defaults, ...overrides };
  const rows = await deps.convexQuery<StoredRow[]>(api.personalDetails.listForUser, { userId: user.userId });
  const views: PersonalDetailView[] = [];
  for (const row of rows || []) {
    if (!isPersonalDetailKey(row.key)) continue;
    const value = openDetail(user.userId, row.key, row.valueEncrypted, deps.decrypt);
    if (value === null) {
      deps.warn('[personal-details] a saved detail did not open', { key: row.key });
      continue;
    }
    views.push(view(row.key, value, row.source, true, row.updatedAt));
  }
  const have = new Set(views.map((entry) => entry.key));
  const accountName = nameFromAccount(user.name);
  if (!have.has('name') && accountName) views.push(view('name', accountName, 'account', false, null));
  const email = String(user.email || '').trim();
  if (!have.has('email') && email) views.push(view('email', email, 'account', false, null));
  return sortViews(views);
}

export function missingDetailKeys(details: readonly PersonalDetailView[]): FixedPersonalDetailKey[] {
  const have = new Set(details.map((entry) => entry.key));
  return PERSONAL_DETAIL_KEYS.filter((key) => !have.has(key));
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export interface DetailInput {
  key: string;
  value: unknown;
  /** The label of a custom detail. */
  label?: string | null;
}

/** Save one detail. Throws PersonalDetailError for a bad key, a refused value, or the limit. */
export async function savePersonalDetail(
  user: PersonalDetailsUser,
  input: DetailInput,
  source: StoredSource,
  overrides: Partial<PersonalDetailsDependencies> = {},
): Promise<PersonalDetailView> {
  const deps = { ...defaults, ...overrides };
  const key = resolveKey(input);
  const value = parseDetailValue(key, input.value, input.label);
  try {
    await deps.convexMutation(api.personalDetails.upsert, {
      userId: user.userId,
      key,
      valueEncrypted: sealDetail(user.userId, key, value, deps.encrypt),
      source,
    });
  } catch (error) {
    if (/most personal details/i.test(String((error as Error)?.message || '')))
      throw new PersonalDetailError(
        'limit',
        key,
        'You keep the most personal details allowed. Delete one first.',
      );
    throw error;
  }
  return view(key, value, source, true, Date.now());
}

export interface SaveManyResult {
  saved: PersonalDetailView[];
  rejected: Array<{ key: string; code: PersonalDetailError['code']; message: string }>;
}

/** Save several details; each one succeeds or fails alone. */
export async function savePersonalDetails(
  user: PersonalDetailsUser,
  inputs: readonly DetailInput[],
  source: StoredSource,
  overrides: Partial<PersonalDetailsDependencies> = {},
): Promise<SaveManyResult> {
  const result: SaveManyResult = { saved: [], rejected: [] };
  for (const input of inputs.slice(0, 12)) {
    try {
      result.saved.push(await savePersonalDetail(user, input, source, overrides));
    } catch (error) {
      if (error instanceof PersonalDetailError)
        result.rejected.push({ key: error.key, code: error.code, message: error.message });
      else throw error;
    }
  }
  return result;
}

/**
 * Save the details bound to a form answer (source "form"). A value equal to
 * the saved one is skipped, so a repeated answer does not replace the Undo
 * value with itself. Returns the labels saved and the refusals.
 */
export async function saveAnsweredDetails(
  user: PersonalDetailsUser,
  inputs: readonly DetailInput[],
  overrides: Partial<PersonalDetailsDependencies> = {},
): Promise<SaveManyResult> {
  if (!inputs.length) return { saved: [], rejected: [] };
  const current = await listPersonalDetails(user, overrides);
  const changed: DetailInput[] = [];
  const rejected: SaveManyResult['rejected'] = [];
  for (const input of inputs) {
    try {
      const key = resolveKey(input);
      const value = parseDetailValue(key, input.value, input.label);
      const saved = current.find((entry) => entry.key === key && entry.saved);
      if (saved && JSON.stringify(saved.value) === JSON.stringify(value)) continue;
      changed.push({ key, value, label: input.label });
    } catch (error) {
      if (error instanceof PersonalDetailError)
        rejected.push({ key: error.key, code: error.code, message: error.message });
      else throw error;
    }
  }
  const result = await savePersonalDetails(user, changed, 'form', overrides);
  return { saved: result.saved, rejected: [...rejected, ...result.rejected] };
}

function resolveKey(input: DetailInput): PersonalDetailKey {
  if (isPersonalDetailKey(input.key)) return input.key;
  if (input.key === 'custom' && input.label) {
    const key = customKeyFor(input.label);
    if (key) return key;
  }
  throw new PersonalDetailError(
    'invalid',
    String(input.key || ''),
    'This is not a personal detail Albatross keeps.',
  );
}

export async function deletePersonalDetail(
  user: PersonalDetailsUser,
  key: string,
  overrides: Partial<PersonalDetailsDependencies> = {},
): Promise<boolean> {
  if (!isPersonalDetailKey(key)) throw new PersonalDetailError('invalid', key, 'Unknown personal detail.');
  const deps = { ...defaults, ...overrides };
  const result = await deps.convexMutation<{ removed: boolean }>(api.personalDetails.remove, {
    userId: user.userId,
    key,
  });
  return Boolean(result?.removed);
}

export async function undoPersonalDetailSave(
  user: PersonalDetailsUser,
  key: string,
  overrides: Partial<PersonalDetailsDependencies> = {},
): Promise<'restored' | 'removed' | 'none'> {
  if (!isPersonalDetailKey(key)) throw new PersonalDetailError('invalid', key, 'Unknown personal detail.');
  const deps = { ...defaults, ...overrides };
  const result = await deps.convexMutation<{ undone: 'restored' | 'removed' | 'none' }>(
    api.personalDetails.undoSave,
    { userId: user.userId, key },
  );
  return result?.undone ?? 'none';
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * The short block for the system prompt: the name and email, and only the
 * NAMES of the other saved details. The values reach the model through
 * personal_details_get on the turns that need them.
 */
export function aboutUserBlock(details: readonly PersonalDetailView[]): string {
  const name = details.find((entry) => entry.key === 'name');
  const email = details.find((entry) => entry.key === 'email');
  const others = details.filter((entry) => entry.key !== 'name' && entry.key !== 'email');
  const missing = missingDetailKeys(details).filter((key) => key !== 'name' && key !== 'email');
  const lines = ['## About the user'];
  if (name)
    lines.push(`Name: ${name.display}${name.saved ? '' : ' (from the account; not confirmed for forms)'}`);
  if (email) lines.push(`Email: ${email.display}`);
  lines.push(
    others.length
      ? `Saved personal details (read the values with personal_details_get when a form needs them): ${others.map((entry) => entry.label).join(', ')}.`
      : 'No other personal details are saved.',
  );
  if (missing.length) lines.push(`Not saved yet: ${missing.map((key) => detailLabel(key)).join(', ')}.`);
  return lines.join('\n');
}
