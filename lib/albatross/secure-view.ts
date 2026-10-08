// Passwords and IDs, as the web client reads them (docs/albatross-secure-store.md
// and docs/research/secure-store-web-design-2026-10-07.md). Pure: the copy
// of the settings tab, the row lines, the allow block, the ask_secure_detail
// card, the composer notice, and the delete dialog. No React, no value of a
// secure item anywhere: every input here is a label, a site, a hint, or a fact.

import {
  ID_NUMBER_LABELS,
  type IdNumberType,
  SECURE_FIELD_LABELS,
  type SecureAllowRequest,
  type SecureItemKind,
  type SecureItemView,
  type SecureRequestInput,
  type SecureUseOutcome,
  type SecureUseView,
} from '../secure/contract';
import {
  looksLikeCardNumber,
  normalizeSite,
  type SecureRefusalReason,
  secureLabelRefusal,
} from '../secure/policy';
import { SECRET_SHAPE_NAMES, type SecretShapeKind, type SecretShapeMatch } from '../secure/redact';

// ---------------------------------------------------------------------------
// The settings tab.
// ---------------------------------------------------------------------------

export const SECURE_COPY = {
  title: 'Passwords and IDs',
  blurb:
    'Albatross uses these on their sites: it signs in, fills a form, or calls a service for you. A saved value never appears again, not here and not in a conversation.',
  nothingSaved: 'Nothing saved yet',
  groups: { sign_in: 'Sign-ins', id_number: 'IDs', api_key: 'Keys' } as Record<
    'sign_in' | 'id_number' | 'api_key',
    string
  >,
  dateOfBirth: 'Date of birth',
  saved: 'Saved',
  notSaved: 'Not saved',
  notUsed: 'Not used yet',
  noSites: 'No sites yet. Albatross asks you the first time a site needs it.',
  add: 'Add',
  addHint: 'A sign-in, an ID, your date of birth, or a key.',
  addMenu: {
    sign_in: 'Sign-in',
    id_number: 'ID',
    date_of_birth: 'Date of birth',
    api_key: 'Key',
  } as Record<SecureItemKind, string>,
  note: 'Albatross types a value only on the sites listed with it. It does not keep card numbers, bank numbers, or two-factor codes.',
  replace: 'Replace',
  remove: 'Remove',
  rename: 'Rename',
  delete: 'Delete',
  cancel: 'Cancel',
  save: 'Save',
  saving: 'Saving…',
  checking: 'One moment',
  open: 'Open',
  close: 'Close',
  sitesTitle: 'Sites that may use it',
  always: 'Always',
  addSite: 'Add',
  addSitePlaceholder: 'A site, such as travel.state.gov',
  addSiteHint: 'Needs one more check first.',
  usesTitle: 'Recent uses',
  usesEmpty: 'No uses yet.',
  usesKept: 'Uses are kept for 90 days.',
  usesLoading: 'Loading…',
  usesError: 'Could not load the uses.',
  loading: 'Loading…',
  loadError: 'Could not load Passwords and IDs.',
  itemSaved: (label: string) => `${label} saved`,
  itemDeleted: (label: string) => `${label} deleted`,
  replaced: (field: string) => `${field} replaced`,
  renamed: 'Name saved',
  siteAdded: (site: string) => `${site} added`,
  siteRemoved: (site: string) => `${site} removed. Albatross asks again next time.`,
  siteCheckCancelled: 'The check did not finish. The site was not added.',
  checkFailed: 'The check could not run. Try again.',
  couldNotSave: 'Could not save this.',
  couldNotDelete: 'Could not delete this.',
  browserGroup: 'In the shared browser',
  deleteAccountLine: 'This also deletes your passwords, IDs, and keys.',
} as const;

export const SECURE_GROUP_ORDER = ['sign_in', 'id_number', 'api_key'] as const;
export type SecureGroupKind = (typeof SECURE_GROUP_ORDER)[number];

export interface SecureGroup {
  kind: SecureGroupKind;
  title: string;
  items: SecureItemView[];
  /** The one date of birth, in the IDs group: the saved item, or null for the empty slot. */
  dateOfBirth?: SecureItemView | null;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** "2029-06" → "June 2029". Anything else comes back as typed. */
export function monthYear(value: string | undefined | null): string | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})/.exec(value);
  if (!match) return value;
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${month} ${match[1]}` : value;
}

/**
 * The three groups in fixed order. Sign-ins and Keys hide when empty; IDs is
 * always present because the date of birth is a fixed slot there.
 */
export function secureGroups(items: readonly SecureItemView[]): SecureGroup[] {
  const sorted = [...items].sort((a, b) => a.label.localeCompare(b.label));
  const groups: SecureGroup[] = [];
  for (const kind of SECURE_GROUP_ORDER) {
    const own = sorted.filter((item) => item.kind === kind);
    if (kind === 'id_number') {
      groups.push({
        kind,
        title: SECURE_COPY.groups[kind],
        items: own,
        dateOfBirth: sorted.find((item) => item.kind === 'date_of_birth') ?? null,
      });
      continue;
    }
    if (own.length) groups.push({ kind, title: SECURE_COPY.groups[kind], items: own });
  }
  return groups;
}

/** "4 saved" for the heading aside, or "Nothing saved yet". */
export function secureCountLine(items: readonly SecureItemView[]): string {
  return items.length ? `${items.length} saved` : SECURE_COPY.nothingSaved;
}

const US_STATES: Record<string, string> = {
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
  DC: 'District of Columbia',
};

/** "NY" → "New York"; any other region comes back as typed. */
export function regionName(region: string | undefined | null): string | null {
  if (!region) return null;
  const upper = region.trim().toUpperCase();
  return US_STATES[upper] ?? region.trim();
}

/** The second line of an item row: the site, then the masked hints and the safe facts. */
export function secureItemLine(item: Pick<SecureItemView, 'kind' | 'sites' | 'hints' | 'facts'>): string {
  const parts: Array<string | null | undefined> = [];
  switch (item.kind) {
    case 'sign_in':
      parts.push(item.sites.join(', '), item.hints.username, item.hints.password);
      break;
    case 'id_number': {
      const expires = monthYear(item.facts.expires);
      parts.push(
        regionName(item.facts.region) ?? item.facts.country ?? null,
        item.hints.number,
        expires ? `expires ${expires}` : null,
      );
      break;
    }
    case 'date_of_birth':
      parts.push(SECURE_COPY.saved);
      break;
    case 'api_key':
      parts.push(item.sites[0], item.hints.key, item.facts.header || 'Authorization: Bearer');
      break;
  }
  return parts.filter((part): part is string => Boolean(part?.trim())).join(' · ');
}

function sameDay(a: Date, b: Date, timeZone?: string) {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return format.format(a) === format.format(b);
}

/** "Last used today, 9:12 AM", "Last used yesterday", "Last used Oct 5", or "Not used yet". */
export function lastUsedLine(
  lastUsedAt: number | null | undefined,
  now = Date.now(),
  format: { locale?: string; timeZone?: string } = {},
): string {
  if (!lastUsedAt) return SECURE_COPY.notUsed;
  const at = new Date(lastUsedAt);
  const today = new Date(now);
  if (sameDay(at, today, format.timeZone)) {
    const time = new Intl.DateTimeFormat(format.locale, {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: format.timeZone,
    }).format(at);
    return `Last used today, ${time}`;
  }
  if (sameDay(at, new Date(now - 86_400_000), format.timeZone)) return 'Last used yesterday';
  const day = new Intl.DateTimeFormat(format.locale, {
    month: 'short',
    day: 'numeric',
    timeZone: format.timeZone,
  });
  return `Last used ${day.format(at)}`;
}

/** The third line of an item row: the last use, or the no-sites line for an ID without sites. */
export function secureItemHint(
  item: Pick<SecureItemView, 'kind' | 'sites' | 'lastUsedAt'>,
  now = Date.now(),
  format: { locale?: string; timeZone?: string } = {},
): string {
  if ((item.kind === 'id_number' || item.kind === 'date_of_birth') && !item.sites.length && !item.lastUsedAt)
    return SECURE_COPY.noSites;
  return lastUsedLine(item.lastUsedAt, now, format);
}

/** The secret fields of an item, each with its label and hint, for the detail. */
export function secureFieldRows(
  item: Pick<SecureItemView, 'kind' | 'hints' | 'facts'>,
): Array<{ field: string; label: string; hint: string }> {
  const rows: Array<{ field: string; label: string; hint: string }> = [];
  for (const [field, hint] of Object.entries(item.hints)) {
    const label = SECURE_FIELD_LABELS[field] ?? field;
    let shown = hint;
    if (field === 'expires') shown = monthYear(item.facts.expires) ?? hint;
    if (shown === 'saved') shown = SECURE_COPY.saved;
    rows.push({ field, label, hint: shown });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Use history.
// ---------------------------------------------------------------------------

export type SecureUseTone = 'did' | 'warn' | 'quiet';

/** The outcome column of a use row. */
export function secureUseLine(
  use: Pick<SecureUseView, 'outcome' | 'field' | 'site'>,
  kind: SecureItemKind,
): string {
  const site = use.site || 'the site';
  switch (use.outcome) {
    case 'typed': {
      if (kind === 'sign_in') return `Signed in to ${site}`;
      const label = use.field ? (SECURE_FIELD_LABELS[use.field] ?? use.field).toLowerCase() : null;
      return label ? `Typed the ${label}` : 'Typed it';
    }
    case 'sent':
      return `Sent to ${site}`;
    case 'refused_site':
      return 'Refused: not one of its sites';
    case 'asked':
      return `Asked to use it on ${site}`;
    case 'allowed_once':
      return `You allowed it on ${site} for one run`;
    case 'allowed_always':
      return `You allowed it on ${site} from now on`;
    case 'denied':
      return `You did not allow it on ${site}`;
  }
}

export function secureUseTone(outcome: SecureUseOutcome): SecureUseTone {
  if (outcome === 'typed' || outcome === 'sent') return 'did';
  if (outcome === 'refused_site') return 'warn';
  return 'quiet';
}

/** "Today, 9:12 AM" or "Oct 2, 4:30 PM". */
export function secureUseTimeLine(
  at: number,
  now = Date.now(),
  format: { locale?: string; timeZone?: string } = {},
) {
  const time = new Intl.DateTimeFormat(format.locale, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: format.timeZone,
  }).format(new Date(at));
  if (sameDay(new Date(at), new Date(now), format.timeZone)) return `Today, ${time}`;
  const day = new Intl.DateTimeFormat(format.locale, {
    month: 'short',
    day: 'numeric',
    timeZone: format.timeZone,
  });
  return `${day.format(new Date(at))}, ${time}`;
}

// ---------------------------------------------------------------------------
// The delete dialog.
// ---------------------------------------------------------------------------

export function deleteDialogCopy(item: Pick<SecureItemView, 'kind' | 'label' | 'sites'>): {
  title: string;
  body: string;
} {
  const site = item.sites[0];
  switch (item.kind) {
    case 'sign_in':
      return {
        title: `Delete ${item.label}?`,
        body: `Albatross can no longer sign in to ${site ?? 'its site'} for you. A run that reaches the ${item.label} sign-in page stops and asks you.`,
      };
    case 'id_number':
      return {
        title: `Delete your ${idPhrase(item.label)}?`,
        body: site
          ? `Albatross can no longer type the number on ${item.sites.join(', ')}. A form that asks for it waits for you.`
          : 'A form that asks for it waits for you.',
      };
    case 'date_of_birth':
      return { title: 'Delete your date of birth?', body: 'A form that asks for it waits for you.' };
    case 'api_key':
      return {
        title: `Delete ${item.label}?`,
        body: `Albatross can no longer call ${site ?? 'its host'} for you.`,
      };
  }
}

// ---------------------------------------------------------------------------
// Refusals and the site preview under the site field.
// ---------------------------------------------------------------------------

export const REFUSAL_COPY: Record<SecureRefusalReason, string> = {
  card: 'This looks like a card number. Albatross does not keep card numbers yet.',
  code: 'Albatross does not keep two-factor or recovery codes. Those stay with you.',
  bank: 'Albatross does not keep bank or routing numbers.',
};

/** The refusal line for a server answer `{ code: 'refused', reason }`, by reason, else the server's text. */
export function refusalLine(reason: string | null | undefined, fallback: string): string {
  return (reason && REFUSAL_COPY[reason as SecureRefusalReason]) || fallback;
}

export type SitePreview = { ok: true; site: string; line: string } | { ok: false; line: string };

/**
 * What the site field saves, as the user types: "Covers chase.com and all its
 * pages." A key keeps its host. An address that is not a site gives the
 * policy's own line.
 */
export function sitePreview(raw: string, kind: SecureItemKind): SitePreview | null {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    const site = normalizeSite(text, kind);
    if (kind === 'api_key') return { ok: true, site, line: `Albatross calls ${site} only.` };
    let host = text.toLowerCase();
    try {
      host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(host) ? host : `https://${host}`).hostname.replace(
        /^www\./,
        '',
      );
    } catch {
      host = site;
    }
    const line =
      host && host !== site
        ? `Covers ${site} and its pages, such as ${host}.`
        : `Covers ${site} and all its pages.`;
    return { ok: true, site, line };
  } catch (error) {
    return {
      ok: false,
      line: error instanceof Error ? error.message : 'Enter a web address, for example chase.com.',
    };
  }
}

export const ID_TYPE_OPTIONS: ReadonlyArray<{ value: IdNumberType; label: string }> = (
  ['drivers_license', 'passport', 'state_id', 'ssn', 'other'] as const
).map((value) => ({ value, label: ID_NUMBER_LABELS[value] }));

/** The sheet's own checks before Save. Keys are field ids; values are the line under the field. */
export function checkSecureValues(
  kind: SecureItemKind,
  values: Record<string, string>,
  options: { label?: string; site?: string } = {},
): Record<string, string> {
  const errors: Record<string, string> = {};
  const need = (field: string, line: string) => {
    if (!values[field]?.trim()) errors[field] = line;
  };
  const labelRefusal = secureLabelRefusal(options.label);
  if (labelRefusal) errors.label = REFUSAL_COPY[labelRefusal];
  switch (kind) {
    case 'sign_in':
      need('username', 'Type the username or email.');
      need('password', 'Type the password.');
      break;
    case 'id_number':
      need('number', values.type === 'ssn' ? 'Use nine digits.' : 'Type the number.');
      if (values.type === 'ssn' && values.number && values.number.replace(/\D/g, '').length !== 9)
        errors.number = 'Use nine digits.';
      if (values.number && looksLikeCardNumber(values.number)) errors.number = REFUSAL_COPY.card;
      if (values.expires && !/^\d{4}-\d{2}-\d{2}$/.test(values.expires)) errors.expires = 'Choose the date.';
      break;
    case 'date_of_birth':
      if (!values.date) errors.date = 'Choose the date.';
      else if (!/^\d{4}-\d{2}-\d{2}$/.test(values.date)) errors.date = 'Choose the date.';
      else if (new Date(`${values.date}T00:00:00Z`).getTime() > Date.now()) errors.date = 'Check the date.';
      break;
    case 'api_key':
      need('key', 'Type the key.');
      if (values.key && looksLikeCardNumber(values.key)) errors.key = REFUSAL_COPY.card;
      break;
  }
  if (kind === 'sign_in' || kind === 'api_key') {
    const preview = sitePreview(options.site ?? '', kind);
    if (!preview)
      errors.site =
        kind === 'api_key' ? 'Type the host, such as api.openai.com.' : 'Type the site, such as chase.com.';
    else if (!preview.ok) errors.site = preview.line;
  }
  return errors;
}

/** "Expired on June 3, 2024" when an expiry date is in the past, else null. A warning, not an error. */
export function expiryWarning(expires: string | undefined, now = Date.now()): string | null {
  if (!expires || !/^\d{4}-\d{2}-\d{2}$/.test(expires)) return null;
  const at = new Date(`${expires}T00:00:00Z`).getTime();
  if (Number.isNaN(at) || at >= now) return null;
  const day = new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return `This ID expired on ${day.format(new Date(at))}. You can still save it.`;
}

// ---------------------------------------------------------------------------
// The allow block (V6).
// ---------------------------------------------------------------------------

export const ALLOW_COPY = {
  once: 'Allow once',
  alwaysOnThisSite: 'Always on this site',
  deny: 'Do not allow',
  checking: 'One moment',
  fine: 'To allow, Albatross needs one more check. It lasts 10 minutes.',
  cancelled: 'The check did not finish. Nothing was allowed.',
  failed: 'The check could not run. Try again.',
  settings: 'Change this in Settings.',
  noLongerOpen: 'No longer open',
} as const;

/** The site label fits a button up to 24 characters; longer sites fall back to the contract label. */
export function allowAlwaysLabel(site: string): string {
  return site.length > 24 ? ALLOW_COPY.alwaysOnThisSite : `Always on ${site}`;
}

/** "Driver's license" → "driver's license"; "State ID" → "state ID"; "SSN" stays. */
function lowerFirst(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return trimmed;
  if (/^[A-Z]{2,}/.test(trimmed)) return trimmed;
  return trimmed[0].toLowerCase() + trimmed.slice(1);
}

/** "driver's license number", "Social Security number", "passport number". */
export function idPhrase(label: string): string {
  const trimmed = label.trim();
  if (/^social security/i.test(trimmed)) return 'Social Security number';
  const lower = lowerFirst(trimmed);
  return /\bnumber$/i.test(lower) ? lower : `${lower} number`;
}

/** The question of the allow block: "Use your driver's license number on ny.gov?" */
export function allowQuestion(allow: Pick<SecureAllowRequest, 'kind' | 'itemLabel' | 'site'>): string {
  switch (allow.kind) {
    case 'id_number':
      return `Use your ${idPhrase(allow.itemLabel)} on ${allow.site}?`;
    case 'date_of_birth':
      return `Use your date of birth on ${allow.site}?`;
    case 'sign_in':
      return `Use your ${allow.itemLabel} sign-in on ${allow.site}?`;
    case 'api_key':
      return `Use your ${allow.itemLabel} key on ${allow.site}?`;
  }
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(', ')}, and ${words[words.length - 1]}`;
}

/** "dmv.ny.gov asks for the number and the expiry date. Albatross types them on the page. They do not appear in this conversation." */
export function allowReason(
  allow: Pick<SecureAllowRequest, 'kind' | 'fieldLabels' | 'site' | 'host'>,
): string {
  const fields = allow.fieldLabels.map((label) => `the ${label.toLowerCase()}`);
  const who = allow.host && allow.host !== allow.site ? allow.host : 'The page';
  const asks =
    allow.kind === 'date_of_birth' || !fields.length
      ? `${who} asks for it.`
      : `${who} asks for ${joinWords(fields)}.`;
  const plural = fields.length > 1;
  const types = plural
    ? 'Albatross types them on the page. They do not appear in this conversation.'
    : 'Albatross types it on the page. It does not appear in this conversation.';
  return `${asks} ${types}`;
}

/** The Brief's "Ready for you" line: the question, after the state. */
export function readyForYouAllowLine(allow: Pick<SecureAllowRequest, 'kind' | 'itemLabel' | 'site'>): string {
  return `Albatross needs your answer: ${lowerFirst(allowQuestion(allow))}`;
}

export type AllowScope = 'once' | 'always' | 'deny';

/** The receipt after an answer (lead decision 10). */
export function allowReceipt(scope: AllowScope, site: string): string {
  switch (scope) {
    case 'once':
      return `Allowed once on ${site}.`;
    case 'always':
      return `Always allowed on ${site}.`;
    case 'deny':
      return 'Not allowed.';
  }
}

/** The stored answer of an allow_secure run, if any. */
export function allowAnswerOf(run: {
  next?: { kind?: string; allowAnswer?: { scope: AllowScope; at: number } | null } | null;
}): { scope: AllowScope; at: number } | null {
  const next = run.next;
  if (!next || next.kind !== 'allow_secure') return null;
  return next.allowAnswer ?? null;
}

// ---------------------------------------------------------------------------
// The ask_secure_detail card (V12) and the sign-in save offer (V13).
// ---------------------------------------------------------------------------

export const REQUEST_COPY = {
  add: 'Add',
  skip: 'Skip',
  skipped: 'Skipped',
  useIt: 'Use it',
  openSettings: 'Open Settings',
  saved: (site: string | null | undefined) =>
    site ? `Saved. Albatross can use it on ${site}.` : 'Saved. Albatross can use it.',
  existsLine: 'Albatross can use it.',
} as const;

/** "Add your sign-in for springfieldwater.gov", "Add your driver's license", "Add your key for api.openai.com". */
export function secureRequestTitle(input: Pick<SecureRequestInput, 'kind' | 'label' | 'site'>): string {
  switch (input.kind) {
    case 'sign_in':
      return input.site ? `Add your sign-in for ${input.site}` : 'Add a sign-in';
    case 'id_number':
      return input.label ? `Add your ${lowerFirst(input.label)}` : 'Add an ID';
    case 'date_of_birth':
      return 'Add your date of birth';
    case 'api_key':
      return input.site ? `Add your key for ${input.site}` : 'Add a key';
  }
}

/** "Your sign-in for springfieldwater.gov is saved" when the list already covers the request. */
export function secureRequestExistsTitle(input: Pick<SecureRequestInput, 'kind' | 'label' | 'site'>): string {
  switch (input.kind) {
    case 'sign_in':
      return input.site ? `Your sign-in for ${input.site} is saved` : 'Your sign-in is saved';
    case 'id_number':
      return input.label ? `Your ${lowerFirst(input.label)} is saved` : 'Your ID is saved';
    case 'date_of_birth':
      return 'Your date of birth is saved';
    case 'api_key':
      return input.site ? `Your key for ${input.site} is saved` : 'Your key is saved';
  }
}

/** The item that already answers a request, from the client's own list, or null. */
export function secureRequestExisting(
  items: readonly SecureItemView[],
  input: Pick<SecureRequestInput, 'kind' | 'label' | 'site'>,
): SecureItemView | null {
  const site = input.site?.trim().toLowerCase();
  const label = input.label?.trim().toLowerCase();
  for (const item of items) {
    if (item.kind !== input.kind) continue;
    if (item.kind === 'date_of_birth') return item;
    if (item.kind === 'sign_in' || item.kind === 'api_key') {
      if (!site) return item;
      if (item.sites.some((own) => own === site || site.endsWith(`.${own}`))) return item;
      continue;
    }
    if (!label || item.label.trim().toLowerCase() === label) return item;
  }
  return null;
}

export const SAVE_SIGN_IN_COPY = {
  offer: (site: string) => `Save a sign-in for ${site}, and the next run signs in by itself.`,
  save: 'Save a sign-in',
  notNow: 'Not now',
  saved: (site: string) => `Sign-in for ${site} saved.`,
  /** The handoff line after the save (lead decision 13). */
  detailAfterSave: 'Saved. Press Continue, and Albatross signs in.',
} as const;

/** A sign-in handoff offers to save a sign-in when none covers its site. */
export function saveSignInOffer(
  run: { state: string; next?: { kind?: string; saveSignIn?: { site: string } | null } | null },
  items: readonly SecureItemView[] = [],
): { site: string } | null {
  if (run.state !== 'handed_off' || run.next?.kind !== 'sign_in' || !run.next.saveSignIn) return null;
  const site = run.next.saveSignIn.site;
  if (secureRequestExisting(items, { kind: 'sign_in', site })) return null;
  return { site };
}

// ---------------------------------------------------------------------------
// The composer notice (V9).
// ---------------------------------------------------------------------------

export const NOTICE_COPY = {
  save: 'Save in Passwords and IDs',
  sendWithout: 'Send without it',
} as const;

/** The notice line for the first secret shape in the draft. */
export function secretNoticeLine(kind: SecretShapeKind): string {
  switch (kind) {
    case 'ssn':
      return 'This looks like a Social Security number. Albatross does not send it.';
    case 'api_key':
      return 'This looks like a key. Albatross does not send it.';
    case 'card':
      return 'This looks like a card number. Albatross does not send it, and it does not keep card numbers yet.';
  }
}

/** Cards have no save action (lead decision 14). */
export function secretNoticeCanSave(kind: SecretShapeKind, storeEnabled: boolean): boolean {
  return storeEnabled && kind !== 'card';
}

/** The marker that replaces a saved value in the draft: "[saved: Social Security number]". */
export function savedMarker(kind: SecretShapeKind): string {
  return `[saved: ${SECRET_SHAPE_NAMES[kind].replace(/^an? /, '')}]`;
}

/** The draft with one match replaced by a marker. */
export function draftWithMarker(text: string, match: SecretShapeMatch, marker: string): string {
  return text.slice(0, match.start) + marker + text.slice(match.end);
}

/** The item the add sheet opens for a pasted value, with the value in its secret field. */
export function secretToItem(
  kind: SecretShapeKind,
  value: string,
): { kind: SecureItemKind; values: Record<string, string> } | null {
  if (kind === 'ssn') return { kind: 'id_number', values: { type: 'ssn', number: value.trim() } };
  if (kind === 'api_key') return { kind: 'api_key', values: { key: value.trim() } };
  return null;
}
