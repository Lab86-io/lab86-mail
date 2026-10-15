// Sealed fields of a saved file (docs/albatross-goal-runs.md, "Secret values
// in a PDF"). A form field that takes a value from Passwords and IDs stays
// empty in the stored bytes. The file keeps the reference only:
// `{ field, ref: '{{secure:<itemId>.<field>|FORMAT}}' }`. The value goes into
// the PDF in memory, when the mail sends or the user downloads the file.
//
// This module is pure. It never reads a value: it checks references against
// the item views (labels, sites, field hints), which hold no value.

import { emailList } from '../nylas/normalize';
import {
  DATE_FORMATS,
  NUMBER_FORMATS,
  SECURE_FIELD_LABELS,
  SECURE_FIELDS,
  type SecureItemKind,
  type SecureItemView,
} from '../secure/contract';
import { findReferences, mentionsReference, referenceLabel, type SecureReference } from '../secure/policy';

/** Only IDs and a date of birth go into a PDF. A password or a key never does. */
export const PDF_SECURE_KINDS: readonly SecureItemKind[] = ['id_number', 'date_of_birth'];

/** The one reference that is the whole value, or null when the value holds no reference. Throws for a mix. */
export function wholeReference(value: string): SecureReference | null {
  if (!mentionsReference(value)) return null;
  const refs = findReferences(value);
  if (refs.length !== 1 || refs[0].raw !== value.trim())
    throw new Error(
      'Write a saved detail as one whole reference, for example {{secure:<id>.number}}, with no other text in the value.',
    );
  return refs[0];
}

/** How many characters a reference fills, when the format fixes it. */
export function sealedValueLength(
  kind: SecureItemKind,
  field: string,
  format: string | null,
  idType?: string | null,
): number | null {
  if (field === 'date' || field === 'expires') {
    switch (format ?? 'YYYY-MM-DD') {
      case 'YYYY-MM-DD':
      case 'MM/DD/YYYY':
      case 'DD/MM/YYYY':
        return 10;
      case 'MM/YYYY':
        return 7;
      case 'MM':
      case 'DD':
        return 2;
      case 'YYYY':
        return 4;
      default:
        return null;
    }
  }
  if (kind === 'id_number' && field === 'number') {
    if (format === 'LAST4' || format === 'SERIAL') return 4;
    if (format === 'AREA') return 3;
    if (format === 'GROUP') return 2;
    if (format === 'DASHED') return 11;
    // A Social Security number is stored as 9 digits.
    if (idType === 'ssn') return 9;
  }
  return null;
}

export type SealedRefCheck =
  | { ok: true; label: string; length: number | null }
  | { ok: false; message: string };

/**
 * Checks one reference against the user's item views: the item exists, it is
 * a kind that may go into a PDF, the field is saved, and the format fits the
 * field. The message is for the model and never holds a value.
 */
export function checkSealedReference(
  reference: SecureReference,
  items: readonly SecureItemView[],
): SealedRefCheck {
  const item = items.find((entry) => entry.id === reference.itemId);
  if (!item)
    return { ok: false, message: 'No saved item has this id. Call secure_details_list for the ids.' };
  if (!PDF_SECURE_KINDS.includes(item.kind))
    return {
      ok: false,
      message: 'A saved password or key never goes into a PDF. Leave the field for the user.',
    };
  if (!SECURE_FIELDS[item.kind].includes(reference.field) || !item.hints[reference.field]) {
    const saved = Object.keys(item.hints).join(', ') || 'none';
    return {
      ok: false,
      message: `${item.label} has no saved "${reference.field}". Its saved fields: ${saved}.`,
    };
  }
  const idType = item.facts.type ?? null;
  if (reference.format) {
    const isDate = reference.field === 'date' || reference.field === 'expires';
    const isNumber = reference.field === 'number';
    const known = isDate
      ? (DATE_FORMATS as readonly string[]).includes(reference.format)
      : isNumber && (NUMBER_FORMATS as readonly string[]).includes(reference.format);
    if (!known)
      return {
        ok: false,
        message: isDate
          ? `Use a date format: ${DATE_FORMATS.join(', ')}.`
          : isNumber
            ? `Use a number format: ${NUMBER_FORMATS.join(', ')}.`
            : `${SECURE_FIELD_LABELS[reference.field] || reference.field} takes no format.`,
      };
    if (isNumber && ['DASHED', 'AREA', 'GROUP', 'SERIAL'].includes(reference.format) && idType !== 'ssn')
      return { ok: false, message: `${reference.format} works only for a Social Security number.` };
  }
  return {
    ok: true,
    label: referenceLabel(item.label, item.kind, reference.field),
    length: sealedValueLength(item.kind, reference.field, reference.format, idType),
  };
}

/** A plain address: an unquoted local part and a host name with at least one dot. */
const PLAIN_ADDRESS =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+)$/;

/**
 * The lower-case mail domains of every recipient in To, Cc, and Bcc. It reads
 * the fields with the same split as the send request (`emailList`), so the
 * check covers each address the provider gets. Null when one recipient is not
 * a plain address, or its name holds an address: a sealed value never goes to
 * an address that this check cannot read.
 */
export function recipientDomains(fields: ReadonlyArray<string | null | undefined>): string[] | null {
  const domains = new Set<string>();
  for (const field of fields)
    for (const entry of emailList(field || undefined)) {
      const match = entry.email.trim().match(PLAIN_ADDRESS);
      if (!match || /[<>@]/.test(entry.name || '')) return null;
      domains.add(match[1].toLowerCase());
    }
  return [...domains];
}
