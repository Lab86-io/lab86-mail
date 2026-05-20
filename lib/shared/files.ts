// Strip control chars and path/forbidden characters, keep readable unicode.
// Done char-by-char (rather than a regex with control chars) so the source
// stays printable and lint-clean.
export function sanitizeFilename(name: string): string {
  const forbidden = '/\\:*?"<>|';
  const cleaned = Array.from(name || '')
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      if (code < 0x20 || code === 0x7f) return '';
      return forbidden.includes(ch) ? '_' : ch;
    })
    .join('')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 200);
  return cleaned || 'attachment';
}

export function formatBytes(n: number): string {
  if (!n || n < 0) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = n;
  let i = -1;
  do {
    value /= 1024;
    i++;
  } while (value >= 1024 && i < units.length - 1);
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}
