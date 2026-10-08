// The secure details contract (docs/albatross-secure-store.md).
//
// The shapes the server, the web client, and the native clients share. No
// value of a secure item appears in any shape here: clients see labels, sites,
// field names, and masked hints. The Swift models in apps/ios mirror these
// names.

import { z } from 'zod';

export const SECURE_ITEM_KINDS = ['sign_in', 'id_number', 'date_of_birth', 'api_key'] as const;
export type SecureItemKind = (typeof SECURE_ITEM_KINDS)[number];

export const ID_NUMBER_TYPES = ['ssn', 'drivers_license', 'passport', 'state_id', 'other'] as const;
export type IdNumberType = (typeof ID_NUMBER_TYPES)[number];

/** The secret fields of each kind. Plain fields (labels, regions) are not listed. */
export const SECURE_FIELDS: Record<SecureItemKind, readonly string[]> = {
  sign_in: ['username', 'password'],
  id_number: ['number', 'expires', 'name_on_id'],
  date_of_birth: ['date'],
  api_key: ['key'],
};

/** The user-facing name of a field. */
export const SECURE_FIELD_LABELS: Record<string, string> = {
  username: 'Username',
  password: 'Password',
  number: 'Number',
  expires: 'Expiry date',
  name_on_id: 'Name on the ID',
  date: 'Date of birth',
  key: 'Key',
};

export const ID_NUMBER_LABELS: Record<IdNumberType, string> = {
  ssn: 'Social Security number',
  drivers_license: "Driver's license",
  passport: 'Passport',
  state_id: 'State ID',
  other: 'ID number',
};

const line = (max: number) => z.string().trim().min(1).max(max);
const date = z
  .string()
  .trim()
  .refine((value) => /^\d{4}-\d{2}-\d{2}$/.test(value), 'Use the date format YYYY-MM-DD.');

/** The values a user enters for one item, by kind. Checked on the server only. */
export const secureValuesSchemas = {
  sign_in: z.object({ username: line(320), password: line(1_000) }),
  id_number: z.object({
    type: z.enum(ID_NUMBER_TYPES),
    number: line(64),
    region: z.string().trim().max(64).optional(),
    country: z.string().trim().max(2).optional(),
    expires: date.optional(),
    name_on_id: z.string().trim().max(160).optional(),
  }),
  date_of_birth: z.object({ date }),
  api_key: z.object({ key: line(4_000), header: z.string().trim().max(120).optional() }),
} as const;

/** One item as every client sees it. No value. */
export interface SecureItemView {
  id: string;
  kind: SecureItemKind;
  /** "Chase", "Driver's license", "OpenAI". */
  label: string;
  /** Registrable domains or API hosts the item may be used on. */
  sites: string[];
  /** Field name → masked hint ("••••", "ends 4821", "sk-…f3a2"). */
  hints: Record<string, string>;
  /** Plain facts that are safe to show: an ID type, a region, a country, an expiry month. */
  facts: Record<string, string>;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

/**
 * typed: a run typed it on a page. sent: secure_fetch sent it to an API host.
 * refused_site: a run asked for it on a site that is not its own. asked: a run
 * asked the user to allow a new site. allowed_once / allowed_always / denied:
 * the user's answer.
 */
export type SecureUseOutcome =
  | 'typed'
  | 'sent'
  | 'refused_site'
  | 'asked'
  | 'allowed_once'
  | 'allowed_always'
  | 'denied';

export interface SecureUseView {
  id: string;
  itemId: string;
  field: string | null;
  site: string | null;
  workId: string | null;
  workTitle: string | null;
  outcome: SecureUseOutcome;
  at: number;
}

/** GET /api/secure-details */
export interface SecureDetailsResponse {
  ok: true;
  /** False when LAB86_SECURE_STORE is off for this user: clients hide the section. */
  enabled: boolean;
  items: SecureItemView[];
}

/** POST /api/secure-details (create) body. */
export interface SecureItemCreate {
  kind: SecureItemKind;
  label?: string;
  sites?: string[];
  values: Record<string, unknown>;
}

/**
 * PUT /api/secure-details/[itemId] body. `values` replaces the secret values;
 * `sites` replaces the site list. Adding a site needs a recent identity check
 * (403 { code: 'verify_identity' }).
 */
export interface SecureItemUpdate {
  label?: string;
  sites?: string[];
  values?: Record<string, unknown>;
}

/** POST /api/secure-details/allow body: the answer to an `allow_secure` handoff. */
export interface SecureAllowAnswer {
  runId: string;
  itemId: string;
  site: string;
  /** 'always' needs a recent identity check (403 { code: 'verify_identity' }). */
  scope: 'once' | 'always' | 'deny';
}

/** The error code that asks the client to confirm the user's identity, then retry. */
export const VERIFY_IDENTITY_CODE = 'verify_identity';

/** How long a factor verification counts for an identity check. */
export const IDENTITY_CHECK_MINUTES = 10;

/**
 * A run handoff for a new site (`next.kind === 'allow_secure'`):
 * `next.target = { kind: 'secure', id: itemId, url: 'https://<site>' }` and
 * `next.allow` (below). The buttons are "Allow once", "Always on this site",
 * and "Do not allow".
 */
export const ALLOW_SECURE_NEXT_KIND = 'allow_secure';

/** `next.allow` on an `allow_secure` handoff: what the run asks to use, and where. */
export interface SecureAllowRequest {
  itemId: string;
  kind: SecureItemKind;
  /** The item label: "Driver's license". */
  itemLabel: string;
  /** The field labels the run asks for: ["Number", "Expiry date"]. */
  fieldLabels: string[];
  /** The registrable domain of the page: "ny.gov". */
  site: string;
  /** The page host, for the detail line: "dmv.ny.gov". */
  host: string;
}

/** `next.saveSignIn` on a `sign_in` handoff when no sign-in is saved for the site (V13). */
export interface SecureSaveSignInOffer {
  site: string;
}

/** GET /api/secure-details/[itemId]/uses */
export interface SecureUsesResponse {
  ok: true;
  uses: SecureUseView[];
}

/**
 * The ask_secure_detail question (V12): a card in the chat that opens the add
 * sheet, and waits. The input names what to add; the answer never holds a value.
 */
export interface SecureRequestInput {
  kind: SecureItemKind;
  label?: string;
  site?: string;
  reason: string;
}

export type SecureRequestAnswer = { saved: true; itemId: string } | { skipped: true };

/** The client capability that turns on ask_secure_detail (lib/ai/loop.ts CLIENT_CAPABILITIES). */
export const ASK_SECURE_DETAIL_CAPABILITY = 'ask_secure_detail';

/** `{{secure:<itemId>.<field>}}` or `{{secure:<itemId>.date|MM/DD/YYYY}}`. */
export const SECURE_REFERENCE =
  /\{\{secure:([A-Za-z0-9_-]{1,64})\.([a-z_]{1,32})(?:\|([A-Z0-9/-]{1,10}))?\}\}/g;

/** Formats of a date field (date, expires). M and D have no leading zero; MONTH is the English name. */
export const DATE_FORMATS = [
  'YYYY-MM-DD',
  'MM/DD/YYYY',
  'DD/MM/YYYY',
  'MM/YYYY',
  'MM',
  'DD',
  'YYYY',
  'M',
  'D',
  'MONTH',
] as const;

/** Formats of an ID number. AREA, GROUP, SERIAL, and DASHED are for a Social Security number only. */
export const NUMBER_FORMATS = ['DIGITS', 'LAST4', 'DASHED', 'AREA', 'GROUP', 'SERIAL'] as const;
