import { z } from 'zod';
import type {
  AddressValue,
  ContactValue,
  CustomValue,
  NameValue,
  PersonalDetailView,
} from '../albatross/thread-contract';
import { type FillPlan, fillPdfForm, PdfFormError, readPdfFormFields } from '../files/pdf-forms';
import {
  getSavedFileRow,
  isPdfFile,
  readSavedFileBytes,
  type SealedField,
  savedFileName,
  saveFileBytes,
} from '../files/saved-files';
import { checkSealedReference, wholeReference } from '../files/sealed-fields';
import { addressLine, fullName, phoneDisplay, phoneParts } from '../personal-details/format';
import { listPersonalDetails } from '../personal-details/store';
import { detectSecretShapes, SECRET_SHAPE_NAMES } from '../secure/redact';
import { listSecureItems, secureStoreEnabled } from '../secure/store';
import { defineTool, type ToolContext } from './registry';

// PDF forms for the chat and the runner (docs/albatross-goal-runs.md G5).
// pdf_form_fields reads the fillable fields of a saved PDF. pdf_form_fill
// writes values into a copy and saves it in Files. A value from Passwords and
// IDs is a reference: the field stays empty in the saved file, and the file
// keeps the reference in sealedFields. The value goes in only when the mail
// sends or the user downloads the file (lib/files/materialize.ts). No result
// here holds a secure value.

export const pdfFormToolDeps = {
  getFile: getSavedFileRow,
  readBytes: readSavedFileBytes,
  saveFile: saveFileBytes,
  listDetails: listPersonalDetails,
  secureEnabled: secureStoreEnabled,
  secureItems: listSecureItems,
};

function userIdOf(ctx: ToolContext) {
  if (!ctx.userId) throw new Error('PDF forms need a signed-in user.');
  return ctx.userId;
}

async function pdfOf(userId: string, fileId: string) {
  const row = await pdfFormToolDeps.getFile(userId, fileId);
  if (!row)
    throw new Error(
      'No saved file has this id. Use the fileId from web_file_save, pdf_form_fill, or the user’s Files.',
    );
  if (!isPdfFile(row)) throw new Error('This file is not a PDF.');
  return { row, bytes: await pdfFormToolDeps.readBytes(row) };
}

function formError(error: unknown): never {
  if (error instanceof PdfFormError) throw new Error(error.message);
  throw error;
}

const FieldRow = z.object({
  name: z.string(),
  label: z.string(),
  type: z.enum(['text', 'check', 'choice', 'radio', 'signature']),
  options: z.array(z.string()).optional(),
  value: z.union([z.string(), z.boolean()]).optional(),
  page: z.number(),
});

export const pdfFormFields = defineTool({
  name: 'pdf_form_fields',
  description:
    'Read the fillable fields of a PDF in Files (for example a W-9 that web_file_save got). Each field has its exact name for pdf_form_fill, a short label, its type (text, check, choice, radio, signature), the options of a list, the current value, and the page. A label ends with "(N characters at most)" when the field is short: split a value to fit, for example a Social Security number in three boxes.',
  category: 'documents',
  mutating: false,
  input: z.object({ fileId: z.string().min(1).max(200).describe('The fileId of a saved PDF.') }),
  output: z.object({ ok: z.literal(true), fileId: z.string(), fields: z.array(FieldRow) }),
  async handler({ fileId }, ctx) {
    const { row, bytes } = await pdfOf(userIdOf(ctx), fileId);
    const fields = await readPdfFormFields(bytes).catch(formError);
    if (!fields.length) throw new Error('This PDF has no fillable fields. The user fills it by hand.');
    return {
      ok: true as const,
      fileId: row._id,
      fields: fields.map((field) => ({
        name: field.name,
        label: field.readOnly ? `${field.label} (read only)` : field.label,
        type: field.type,
        ...(field.options ? { options: field.options } : {}),
        ...(field.value !== undefined ? { value: field.value } : {}),
        page: field.page,
      })),
    };
  },
});

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

const DetailValue = z.object({
  detail: z
    .string()
    .min(1)
    .max(80)
    .describe(
      'A saved personal detail: name, name.first, name.middle, name.last, email, phone, phone.area, phone.prefix, phone.line, home_address, home_address.street, home_address.cityLine (City, ST 12345), home_address.city, home_address.region, home_address.postalCode, home_address.country, emergency_contact, or a custom:<key>.',
    ),
});

const FillValue = z.object({
  field: z.string().min(1).max(300).describe('The exact field name from pdf_form_fields.'),
  value: z
    .union([z.string().max(2_000), z.boolean(), DetailValue])
    .describe(
      'Text, the option of a list or a radio group, true or false for a check box, { detail } for a saved personal detail, or one reference {{secure:<id>.<field>}} (with |FORMAT when the field needs one) for an ID number or a date of birth from secure_details_list.',
    ),
});

/** The text of one personal detail or one part of it, or null when it is not saved. */
export function personalDetailText(details: readonly PersonalDetailView[], path: string): string | null {
  const [key, part = ''] = path.trim().split(/\.(.*)/s, 2);
  const detail = details.find((entry) => entry.key === key);
  if (!detail) return null;
  const value = detail.value;
  const pick = (text: string | undefined | null) => {
    const clean = String(text ?? '').trim();
    return clean || null;
  };
  switch (key) {
    case 'name': {
      const name = value as NameValue;
      if (!part || part === 'full') return pick(fullName(name));
      return part === 'first' || part === 'middle' || part === 'last' ? pick(name[part]) : null;
    }
    case 'home_address': {
      const address = value as AddressValue;
      if (!part) return pick(addressLine(address));
      if (part === 'street') return pick([address.line1, address.line2].filter(Boolean).join(', '));
      if (part === 'cityLine') return pick(`${address.city}, ${address.region} ${address.postalCode}`);
      return ['line1', 'line2', 'city', 'region', 'postalCode', 'country'].includes(part)
        ? pick(address[part as keyof AddressValue])
        : null;
    }
    case 'phone': {
      const phone = phoneParts(String(value));
      if (!part) return pick(phoneDisplay(String(value)));
      return ['e164', 'national', 'area', 'prefix', 'line'].includes(part)
        ? pick(phone[part as 'e164' | 'national' | 'area' | 'prefix' | 'line'])
        : null;
    }
    case 'emergency_contact': {
      const contact = value as ContactValue;
      if (!part) return pick(detail.display);
      return ['name', 'phone', 'relationship'].includes(part)
        ? pick(contact[part as keyof ContactValue])
        : null;
    }
    default:
      if (part) return null;
      return pick(typeof value === 'string' ? value : (value as CustomValue)?.value);
  }
}

function pdfName(source: string, title: string | undefined): string {
  if (title?.trim()) {
    const name = savedFileName(title.trim(), 'Filled form');
    return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
  }
  const base = source.replace(/\.pdf$/i, '').replace(/ \(filled\)$/i, '');
  return savedFileName(`${base} (filled).pdf`, 'Filled form.pdf');
}

const SavedOut = z.object({
  ok: z.literal(true),
  fileId: z.string(),
  title: z.string(),
  openPath: z.string(),
  size: z.number(),
  contentType: z.string(),
  sourceUrl: z.string().optional(),
  sha256: z.string(),
  sealedFields: z.array(z.object({ field: z.string(), ref: z.string() })).optional(),
  /** The fields this fill wrote a value in (pdf_fill only). */
  filled: z.array(z.string()).optional(),
});

export const pdfFormFill = defineTool({
  name: 'pdf_form_fill',
  description:
    'Fill the fields of a PDF in Files and save the result as a new PDF in Files. The form stays fillable, so the user can change any value. Read the names with pdf_form_fields first. Never fill a signature field: Albatross never signs, and the user signs. For an ID number or a date of birth, send a {{secure:<id>.<field>}} reference, never the number: that field stays empty in the saved file and fills only when the user sends the mail (to a site the item is saved for) or downloads the file. A Social Security number in three boxes takes AREA, GROUP, and SERIAL formats. Attach the new file to a draft with save_draft or update_draft (provider upload). The result lists the fields it filled and the sealed fields. Give the user the openPath as a Markdown link.',
  category: 'documents',
  risk: 'write_self',
  mutating: true,
  input: z.object({
    fileId: z.string().min(1).max(200).describe('The fileId of the saved PDF to fill.'),
    values: z.array(FillValue).min(1).max(200),
    title: z
      .string()
      .max(120)
      .optional()
      .describe('The name of the new file. Default: "<name> (filled).pdf".'),
  }),
  output: SavedOut,
  async handler({ fileId, values, title }, ctx) {
    const userId = userIdOf(ctx);
    const { row, bytes } = await pdfOf(userId, fileId);
    const problems: string[] = [];
    const plain: Record<string, string | boolean> = {};
    const sealed: Array<{ field: string; ref: string; length: number | null }> = [];
    const seen = new Set<string>();
    let details: PersonalDetailView[] | null = null;
    let items: Awaited<ReturnType<typeof listSecureItems>> | null = null;

    for (const { field, value } of values) {
      if (seen.has(field)) {
        problems.push(`${field}: send each field once.`);
        continue;
      }
      seen.add(field);
      if (typeof value === 'boolean') {
        plain[field] = value;
        continue;
      }
      if (typeof value === 'object') {
        details ??= await pdfFormToolDeps.listDetails({
          userId,
          name: ctx.userName,
          email: ctx.userEmail,
        });
        const text = personalDetailText(details, value.detail);
        if (text === null)
          problems.push(
            `${field}: no saved personal detail "${value.detail}". Read personal_details_get, or ask the user.`,
          );
        else plain[field] = text;
        continue;
      }
      let ref: ReturnType<typeof wholeReference>;
      try {
        ref = wholeReference(value);
      } catch (error) {
        problems.push(`${field}: ${(error as Error).message}`);
        continue;
      }
      if (!ref) {
        const shape = detectSecretShapes(value)[0];
        if (shape)
          problems.push(
            `${field}: this looks like ${SECRET_SHAPE_NAMES[shape.kind]}. Send a {{secure:<id>.<field>}} reference from secure_details_list, or leave the field for the user.`,
          );
        else plain[field] = value;
        continue;
      }
      if (!pdfFormToolDeps.secureEnabled(userId)) {
        problems.push(
          `${field}: Passwords and IDs is not available for this account. Leave the field for the user.`,
        );
        continue;
      }
      items ??= await pdfFormToolDeps.secureItems(userId);
      const check = checkSealedReference(ref, items);
      if (!check.ok) problems.push(`${field}: ${check.message}`);
      else sealed.push({ field, ref: ref.raw, length: check.length });
    }
    if (problems.length) throw new Error(`Nothing was filled. Fix these values: ${problems.join(' ')}`);

    const plan: FillPlan = {
      values: plain,
      sealed: sealed.map(({ field, length }) => ({ field, length })),
    };
    const filled = await fillPdfForm(bytes, plan).catch(formError);
    // Sealed fields of the source stay sealed unless this fill gives the field a new value.
    const sealedFields: SealedField[] = [
      ...(row.sealedFields ?? []).filter((entry) => !seen.has(entry.field)),
      ...sealed.map(({ field, ref }) => ({ field, ref })),
    ];
    const saved = await pdfFormToolDeps.saveFile({
      userId,
      bytes: filled.bytes,
      name: pdfName(row.name, title),
      contentType: 'application/pdf',
      origin: 'filled',
      ...(row.sourceUrl ? { sourceUrl: row.sourceUrl } : {}),
      ...(sealedFields.length ? { sealedFields } : {}),
      ...(row.workId ? { workId: row.workId } : {}),
    });
    return {
      ok: true as const,
      ...saved,
      ...(sealedFields.length ? { sealedFields } : {}),
      filled: filled.filled,
    };
  },
});
