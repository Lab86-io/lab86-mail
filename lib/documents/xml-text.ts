// XML 1.0 does not allow most control characters, unpaired surrogates, or
// U+FFFE and U+FFFF. A file with one of them does not open. The renderers escape
// only entities, so all text goes through these functions first.

export function xmlSafeText(value: string): string {
  let out = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const allowed =
      code >= 0x20
        ? code !== 0xfffe && code !== 0xffff && !(code >= 0xd800 && code <= 0xdfff)
        : code === 0x9 || code === 0xa || code === 0xd;
    if (allowed) out += character;
  }
  return out;
}

/** The same value with each string made safe. Keys stay as they are. */
export function xmlSafeDeep<T>(value: T): T {
  if (typeof value === 'string') return xmlSafeText(value) as T;
  if (Array.isArray(value)) return value.map(xmlSafeDeep) as T;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, xmlSafeDeep(entry)]),
  ) as T;
}
