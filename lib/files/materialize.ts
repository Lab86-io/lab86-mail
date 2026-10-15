// A saved file at the moment of use (docs/albatross-goal-runs.md, "Secret
// values in a PDF"). A file with sealed fields fills them here, in memory,
// and only for one purpose:
//
// - send: every recipient domain needs a send grant for the item: "Always for
//   mail to <domain>" (the item's mailDomains) or "Allow for this send" (a
//   single-use grant for this send key). A send grant is not a site: the
//   item's sites never let a mail carry the value (lib/secure/send-grants.ts).
// - download: the user passed the identity check ("One more check") in the
//   last 10 minutes. The route checks it and says so here.
//
// The filled bytes go to the caller and nowhere else: they are not stored, not
// logged, and not given to a model. Each fill is a line in the item's use
// history. A file without sealed fields comes back as it is stored.

import { SECURE_FIELD_LABELS, type SecureItemView } from '../secure/contract';
import { formatSecureValue, type SecureReference, siteCovers, siteForHost } from '../secure/policy';
import { sendGrantCovers } from '../secure/send-grants';
import {
  listSecureItems,
  type OpenedItem,
  openSecureItems,
  recordSecureUse,
  secureStoreEnabled,
} from '../secure/store';
import { fillPdfForm, PdfFormError } from './pdf-forms';
import { getSavedFileRow, readSavedFileBytes, type SavedFileRow, type SealedField } from './saved-files';
import { checkSealedReference, recipientDomains, wholeReference } from './sealed-fields';

export type MaterializePurpose =
  | {
      kind: 'send';
      recipients: ReadonlyArray<string | null | undefined>;
      workId?: string;
      /** The send key (outbox key) when the client showed a valid "Allow for this send" token. */
      sendKey?: string;
    }
  | { kind: 'download'; checked: boolean };

export type SealedFileErrorCode =
  | 'not_found'
  | 'off'
  | 'gone'
  | 'needs_allow'
  | 'verify_identity'
  | 'invalid'
  | 'allow_ended';

export class SealedFileError extends Error {
  constructor(
    readonly code: SealedFileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SealedFileError';
  }
}

/** One item that may not go to some recipient domains yet. */
export interface SealedAllowNeed {
  itemId: string;
  itemLabel: string;
  /** "Number", "Date of birth". */
  fieldLabels: string[];
  /** The recipient mail domains with no send grant for the item: "example.com". */
  domains: string[];
}

/** A send to a mail domain with no send grant. The user allows it for this send or always. */
export class SealedFileNeedsAllow extends SealedFileError {
  readonly grant = 'send' as const;
  constructor(readonly needs: SealedAllowNeed[]) {
    const first = needs[0];
    super(
      'needs_allow',
      `This file has your saved ${first.itemLabel}. Before it goes in mail to ${first.domains.join(', ')}, allow it for this send or for all mail to that domain.`,
    );
    this.name = 'SealedFileNeedsAllow';
  }

  /** Every domain that needs a grant, once. */
  get domains(): string[] {
    return [...new Set(this.needs.flatMap((need) => need.domains))];
  }
}

/** A download of a file with saved details needs the identity check first. */
export class SealedFileNeedsCheck extends SealedFileError {
  constructor() {
    super(
      'verify_identity',
      'Albatross needs one more check before it puts your saved details in this file.',
    );
    this.name = 'SealedFileNeedsCheck';
  }
}

export const materializeDeps = {
  getFile: getSavedFileRow,
  readBytes: readSavedFileBytes,
  enabled: secureStoreEnabled,
  listItems: listSecureItems,
  openItems: openSecureItems,
  recordUse: recordSecureUse,
  sendGrantCovers: (input: { userId: string; itemId: string; domain: string; sendKey: string }) =>
    sendGrantCovers(input),
};

export interface MaterializedFile {
  bytes: Uint8Array;
  name: string;
  contentType: string;
  /** True when saved details went into the bytes. */
  sealed: boolean;
}

interface ParsedSealed {
  field: string;
  ref: SecureReference;
}

const GONE = 'A saved detail that this file uses is not in Passwords and IDs any more. Fill the form again.';

function parseSealed(sealed: readonly SealedField[]): ParsedSealed[] {
  return sealed.map((entry) => {
    let ref: SecureReference | null = null;
    try {
      ref = wholeReference(entry.ref);
    } catch {
      ref = null;
    }
    if (!ref) throw new SealedFileError('gone', GONE);
    return { field: entry.field, ref };
  });
}

/**
 * The recipient domains that each sealed item has no send grant for. Empty
 * when the send may go. The item's sites do not count: a site is for pages.
 */
async function allowNeeds(
  userId: string,
  sealed: readonly ParsedSealed[],
  items: ReadonlyArray<Pick<SecureItemView, 'id' | 'label' | 'mailDomains'>>,
  domains: readonly string[],
  sendKey: string | undefined,
  deps: typeof materializeDeps,
): Promise<SealedAllowNeed[]> {
  const needs = new Map<string, SealedAllowNeed>();
  for (const { ref } of sealed) {
    const item = items.find((entry) => entry.id === ref.itemId);
    if (!item) throw new SealedFileError('gone', GONE);
    for (const host of domains) {
      const domain = siteForHost(host) || host;
      if ((item.mailDomains ?? []).some((allowed) => siteCovers(allowed, host))) continue;
      if (sendKey && (await deps.sendGrantCovers({ userId, itemId: item.id, domain, sendKey }))) continue;
      const need = needs.get(item.id) ?? {
        itemId: item.id,
        itemLabel: item.label,
        fieldLabels: [],
        domains: [],
      };
      if (!need.domains.includes(domain)) need.domains.push(domain);
      const label = SECURE_FIELD_LABELS[ref.field] || ref.field;
      if (!need.fieldLabels.includes(label)) need.fieldLabels.push(label);
      needs.set(item.id, need);
    }
  }
  return [...needs.values()];
}

async function ownedRow(userId: string, fileId: string, deps: typeof materializeDeps): Promise<SavedFileRow> {
  const row = await deps.getFile(userId, fileId);
  if (!row) throw new SealedFileError('not_found', 'This file is not in Files any more.');
  return row;
}

function requireStore(userId: string, deps: typeof materializeDeps) {
  if (!deps.enabled(userId))
    throw new SealedFileError(
      'off',
      'This file uses saved details from Passwords and IDs, and Passwords and IDs is off for this account.',
    );
}

function domainsOf(recipients: MaterializePurpose & { kind: 'send' }): string[] {
  const domains = recipientDomains(recipients.recipients);
  if (!domains.length) throw new SealedFileError('invalid', 'Add a recipient first.');
  return domains;
}

/**
 * The check of a send without a fill: for a held send (Undo), the route
 * checks now and fills when the hold ends. Throws SealedFileNeedsAllow.
 * Returns true when the file has sealed fields.
 */
export async function checkSavedFileSend(
  userId: string,
  fileId: string,
  recipients: ReadonlyArray<string | null | undefined>,
  sendKey?: string,
  deps: typeof materializeDeps = materializeDeps,
): Promise<boolean> {
  const row = await ownedRow(userId, fileId, deps);
  if (!row.sealedFields?.length) return false;
  requireStore(userId, deps);
  const sealed = parseSealed(row.sealedFields);
  const domains = domainsOf({ kind: 'send', recipients });
  const items = await deps.listItems(userId);
  for (const { ref } of sealed)
    if (!checkSealedReference(ref, items).ok) throw new SealedFileError('gone', GONE);
  const needs = await allowNeeds(userId, sealed, items, domains, sendKey, deps);
  if (needs.length) throw new SealedFileNeedsAllow(needs);
  return true;
}

/**
 * The bytes of a saved file for one use. Sealed fields are filled in memory.
 * Throws SealedFileError: not_found, off, gone, invalid; SealedFileNeedsAllow
 * for a send; SealedFileNeedsCheck for a download without the check.
 */
export async function materializeSavedFile(
  userId: string,
  fileId: string,
  purpose: MaterializePurpose,
  deps: typeof materializeDeps = materializeDeps,
): Promise<MaterializedFile> {
  const row = await ownedRow(userId, fileId, deps);
  const contentType = row.contentType || 'application/octet-stream';
  if (!row.sealedFields?.length)
    return { bytes: await deps.readBytes(row), name: row.name, contentType, sealed: false };
  if (purpose.kind === 'download' && !purpose.checked) throw new SealedFileNeedsCheck();
  requireStore(userId, deps);
  const sealed = parseSealed(row.sealedFields);
  const domains = purpose.kind === 'send' ? domainsOf(purpose) : [];
  const opened: OpenedItem[] = await deps.openItems(userId);
  if (purpose.kind === 'send') {
    const needs = await allowNeeds(
      userId,
      sealed,
      opened.map((entry) => entry.item),
      domains,
      purpose.sendKey,
      deps,
    );
    if (needs.length) throw new SealedFileNeedsAllow(needs);
  }
  const values: Record<string, string> = {};
  for (const { field, ref } of sealed) {
    const entry = opened.find((candidate) => candidate.item.id === ref.itemId);
    const value = entry?.values[ref.field];
    if (!entry || !value || !checkSealedReference(ref, [entry.item]).ok)
      throw new SealedFileError('gone', GONE);
    try {
      values[field] = formatSecureValue({
        kind: entry.item.kind,
        field: ref.field,
        value,
        format: ref.format,
        idType: entry.item.facts.type,
      });
    } catch {
      throw new SealedFileError('gone', GONE);
    }
  }
  let filled: Uint8Array;
  try {
    filled = (await fillPdfForm(await deps.readBytes(row), { values })).bytes;
  } catch (error) {
    // The form error names fields, never values.
    if (error instanceof PdfFormError)
      throw new SealedFileError(
        'gone',
        'A saved detail does not fit this form any more. Fill the form again.',
      );
    throw error;
  }
  const recorded = new Set<string>();
  for (const { ref } of sealed) {
    const sites = purpose.kind === 'send' ? domains : [null];
    for (const domain of sites) {
      const key = `${ref.itemId}:${ref.field}:${domain ?? ''}`;
      if (recorded.has(key)) continue;
      recorded.add(key);
      await deps.recordUse({
        userId,
        itemId: ref.itemId,
        field: ref.field,
        outcome: purpose.kind === 'send' ? 'sent' : 'downloaded',
        ...(domain ? { site: siteForHost(domain) || domain, host: domain } : {}),
        ...(purpose.kind === 'send' && purpose.workId ? { workId: purpose.workId } : {}),
      });
    }
  }
  return { bytes: filled, name: row.name, contentType: 'application/pdf', sealed: true };
}
