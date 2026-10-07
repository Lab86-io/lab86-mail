// Form questions (docs/albatross-thread.md, "Questions are forms"). Pure: the
// agent route, the answer route, and the tests use these to check an answer,
// to find the personal details it binds, and to write the answer for a run.

import { phoneDisplay } from '../personal-details/format';
import { truncateText } from '../shared/text';
import {
  addressValueSchema,
  contactValueSchema,
  emailValueSchema,
  type FormField,
  type FormFieldValue,
  type FormQuestion,
  formQuestionSchema,
  isPersonalDetailKey,
  nameValueSchema,
  type PersonalDetailKey,
  phoneValueSchema,
} from './thread-contract';

export interface CheckedAnswer {
  ok: boolean;
  /** Normalized values for the fields that have one. */
  values: Record<string, FormFieldValue>;
  /** Field id → what to fix, in user copy. */
  errors: Record<string, string>;
}

export function parseFormQuestion(raw: unknown): FormQuestion | null {
  const parsed = formQuestionSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return !value.trim();
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') {
    const choice = value as { choices?: unknown; other?: unknown };
    if ('choices' in choice)
      return (
        (!Array.isArray(choice.choices) || choice.choices.length === 0) && !String(choice.other || '').trim()
      );
    return Object.values(value).every(isEmpty);
  }
  return false;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function validDate(text: string): boolean {
  const match = DATE.exec(text);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1;
}

/** Check one field value. Returns the normalized value, or an error string. */
export function checkFieldValue(
  field: FormField,
  raw: unknown,
): { value: FormFieldValue } | { error: string } {
  switch (field.kind) {
    case 'choice': {
      const choice =
        typeof raw === 'string'
          ? { choices: [raw] }
          : Array.isArray(raw)
            ? { choices: raw.map(String) }
            : (raw as { choices?: unknown; other?: unknown }) || {};
      const known = new Set((field.options || []).map((option) => option.id));
      const choices = (Array.isArray(choice.choices) ? choice.choices : [])
        .map(String)
        .filter((id) => known.has(id));
      const other = field.allowOther ? truncateText(String(choice.other || '').trim(), 400) : '';
      if (!choices.length && !other) return { error: 'Choose one.' };
      if (!field.multiple && choices.length > 1) return { error: 'Choose only one.' };
      return { value: other ? { choices, other } : { choices } };
    }
    case 'phone': {
      const parsed = phoneValueSchema.safeParse(raw);
      return parsed.success ? { value: parsed.data } : { error: 'Type a phone number.' };
    }
    case 'email': {
      const parsed = emailValueSchema.safeParse(raw);
      return parsed.success ? { value: parsed.data } : { error: 'Type an email address.' };
    }
    case 'date': {
      const text = String(raw ?? '').trim();
      return validDate(text) ? { value: text } : { error: 'Choose a date.' };
    }
    case 'number': {
      const text = String(raw ?? '').trim();
      return text && Number.isFinite(Number(text)) ? { value: text } : { error: 'Type a number.' };
    }
    case 'name': {
      const parsed = nameValueSchema.safeParse(raw);
      return parsed.success ? { value: parsed.data } : { error: 'Type the first and last name.' };
    }
    case 'address': {
      const parsed = addressValueSchema.safeParse(raw);
      return parsed.success ? { value: parsed.data } : { error: 'Complete the address.' };
    }
    case 'contact': {
      const parsed = contactValueSchema.safeParse(raw);
      return parsed.success ? { value: parsed.data } : { error: 'Type the name and phone number.' };
    }
    default: {
      const text = String(raw ?? '').trim();
      return text ? { value: truncateText(text, 2_000) } : { error: 'Type an answer.' };
    }
  }
}

/** Check a whole answer against its form. Optional empty fields are left out. */
export function checkFormAnswer(form: FormQuestion, rawValues: Record<string, unknown>): CheckedAnswer {
  const values: Record<string, FormFieldValue> = {};
  const errors: Record<string, string> = {};
  for (const field of form.fields) {
    const raw = rawValues?.[field.id];
    if (isEmpty(raw)) {
      if (field.required !== false)
        errors[field.id] = field.kind === 'choice' ? 'Choose one.' : 'This is required.';
      continue;
    }
    const checked = checkFieldValue(field, raw);
    if ('error' in checked) errors[field.id] = checked.error;
    else values[field.id] = checked.value;
  }
  return { ok: Object.keys(errors).length === 0, values, errors };
}

/** Which detail kinds a field kind may bind to. */
function bindable(field: FormField, key: PersonalDetailKey): boolean {
  if (key.startsWith('custom:')) return field.kind === 'text' || field.kind === 'number';
  const map: Record<string, FormField['kind']> = {
    name: 'name',
    email: 'email',
    phone: 'phone',
    home_address: 'address',
    emergency_contact: 'contact',
  };
  return map[key] === field.kind;
}

/** The personal details that an answer binds, ready for savePersonalDetails. */
export function boundDetailInputs(
  form: FormQuestion,
  values: Record<string, FormFieldValue>,
): Array<{ key: PersonalDetailKey; value: unknown; label?: string }> {
  const out: Array<{ key: PersonalDetailKey; value: unknown; label?: string }> = [];
  for (const field of form.fields) {
    const key = field.detailKey;
    if (!key || !isPersonalDetailKey(key) || !bindable(field, key)) continue;
    const value = values[field.id];
    if (value === undefined) continue;
    out.push(key.startsWith('custom:') ? { key, value, label: field.label } : { key, value });
  }
  return out;
}

function describeValue(field: FormField, value: FormFieldValue): string {
  if (field.kind === 'choice') {
    const choice = value as { choices: string[]; other?: string };
    const labels = choice.choices.map((id) => {
      const option = field.options?.find((entry) => entry.id === id);
      return option ? `${option.label}${option.detail ? ` (${option.detail})` : ''}` : id;
    });
    if (choice.other) labels.push(`Other: ${choice.other}`);
    return labels.join('; ');
  }
  if (field.kind === 'phone') return phoneDisplay(value as string);
  if (typeof value === 'string') return value;
  if (field.kind === 'name') {
    const name = value as { first: string; middle?: string; last: string };
    return [name.first, name.middle, name.last].filter(Boolean).join(' ');
  }
  if (field.kind === 'address') {
    const address = value as {
      line1: string;
      line2?: string;
      city: string;
      region: string;
      postalCode: string;
      country: string;
    };
    return [
      address.line1,
      address.line2,
      address.city,
      `${address.region} ${address.postalCode}`,
      address.country,
    ]
      .filter(Boolean)
      .join(', ');
  }
  const contact = value as { name: string; phone: string; relationship?: string };
  return `${contact.name}${contact.relationship ? ` (${contact.relationship})` : ''}, ${phoneDisplay(contact.phone)}`;
}

/**
 * The answer as text for the run and for the Work question record: one line
 * per answered field. Saved details are named, so the run reads them back
 * with personal_details_get instead of copying them from here.
 */
export function formAnswerText(
  form: FormQuestion,
  values: Record<string, FormFieldValue>,
  savedLabels: readonly string[] = [],
): string {
  const lines = form.fields
    .filter((field) => values[field.id] !== undefined)
    .map((field) => `${field.label}: ${describeValue(field, values[field.id])}`);
  if (savedLabels.length) lines.push(`Saved to the user's personal details: ${savedLabels.join(', ')}.`);
  return lines.join('\n') || 'The user answered.';
}
