// Display and form shapes for personal details. Pure: the settings list, the
// agent tool, and the form prefill all read these.

import type {
  AddressValue,
  ContactValue,
  CustomValue,
  NameValue,
  PersonalDetailKey,
  PersonalDetailValue,
} from '../albatross/thread-contract';
import { PERSONAL_DETAIL_LABELS } from '../albatross/thread-contract';

export function isCustomKey(key: PersonalDetailKey): key is `custom:${string}` {
  return key.startsWith('custom:');
}

export function detailLabel(key: PersonalDetailKey, value?: PersonalDetailValue | null): string {
  if (isCustomKey(key)) {
    const label = value && typeof value === 'object' && 'label' in value ? String(value.label) : '';
    return label || key.slice('custom:'.length).replace(/[-_]+/g, ' ');
  }
  return PERSONAL_DETAIL_LABELS[key];
}

export function fullName(value: NameValue): string {
  return [value.first, value.middle, value.last].filter((part) => part?.trim()).join(' ');
}

export function addressLine(value: AddressValue): string {
  const street = [value.line1, value.line2].filter((part) => part?.trim()).join(', ');
  const region = [value.region, value.postalCode].filter(Boolean).join(' ');
  const tail = value.country && value.country !== 'US' ? `, ${value.country}` : '';
  return `${street}, ${value.city}, ${region}${tail}`;
}

export interface PhoneParts {
  /** Digits only, without the country code for a North American number. */
  national: string;
  /** "+1" for a North American number, else the leading + group when given. */
  countryCode: string | null;
  /** North American numbers only: the three boxes that split forms use. */
  area: string | null;
  prefix: string | null;
  line: string | null;
  /** E.164 when the number is complete enough, else null. */
  e164: string | null;
}

/** The parts of a phone number, for forms with one box or three. */
export function phoneParts(raw: string): PhoneParts {
  const text = String(raw || '').trim();
  const digits = text.replace(/\D/g, '');
  const explicitPlus = text.startsWith('+');
  const nanp = (digits.length === 10 && !explicitPlus) || (digits.length === 11 && digits.startsWith('1'));
  if (nanp) {
    const national = digits.length === 11 ? digits.slice(1) : digits;
    return {
      national,
      countryCode: '+1',
      area: national.slice(0, 3),
      prefix: national.slice(3, 6),
      line: national.slice(6),
      e164: `+1${national}`,
    };
  }
  return {
    national: digits,
    countryCode: explicitPlus ? `+${digits.slice(0, Math.max(1, digits.length - 9))}` : null,
    area: null,
    prefix: null,
    line: null,
    e164: explicitPlus && digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null,
  };
}

/** "(607) 555-0100" for a North American number, else the number as typed. */
export function phoneDisplay(raw: string): string {
  const parts = phoneParts(raw);
  if (parts.area && parts.prefix && parts.line) return `(${parts.area}) ${parts.prefix}-${parts.line}`;
  return String(raw || '').trim();
}

/** One line for lists and receipts. */
export function detailDisplay(key: PersonalDetailKey, value: PersonalDetailValue): string {
  if (isCustomKey(key)) return (value as CustomValue).value;
  switch (key) {
    case 'name':
      return fullName(value as NameValue);
    case 'phone':
      return phoneDisplay(value as string);
    case 'home_address':
      return addressLine(value as AddressValue);
    case 'emergency_contact': {
      const contact = value as ContactValue;
      const relation = contact.relationship ? ` (${contact.relationship})` : '';
      return `${contact.name}${relation}, ${phoneDisplay(contact.phone)}`;
    }
    default:
      return String(value);
  }
}

/** Split an account display name into a name value, or null when it has fewer than two words. */
export function nameFromAccount(raw: string | null | undefined): NameValue | null {
  const words = String(raw || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length < 2) return null;
  return {
    first: words[0],
    ...(words.length > 2 ? { middle: words.slice(1, -1).join(' ') } : {}),
    last: words[words.length - 1],
  };
}
