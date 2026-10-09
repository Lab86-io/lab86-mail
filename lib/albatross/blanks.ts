// The blank: the user's part of a handoff, drawn as the form line it is.
// A run that leaves fields empty for the user names them in next.blanks
// ("hours for each week", "hourly rate"). Every surface draws the same
// sentence, "Fill in ___, ___, and ___.", with the field name under each
// line (docs/albatross-blank-design.md). iOS and macOS mirror these rules in
// BlankSentence.swift.

export type BlankPart = { kind: 'text'; text: string } | { kind: 'blank'; name: string };

/** The blanks of a run's next action, or none. */
export function handoffBlanks(next: { blanks?: readonly string[] | null } | null | undefined): string[] {
  return (next?.blanks || []).map((name) => name.trim()).filter(Boolean);
}

/** "Fill in [a]." / "Fill in [a] and [b]." / "Fill in [a], [b], and [c]." */
export function blankSentence(blanks: readonly string[]): BlankPart[] {
  const names = blanks.map((name) => name.trim()).filter(Boolean);
  if (!names.length) return [];
  const parts: BlankPart[] = [{ kind: 'text', text: 'Fill in ' }];
  names.forEach((name, index) => {
    if (index > 0) {
      const last = index === names.length - 1;
      parts.push({ kind: 'text', text: last ? (names.length === 2 ? ' and ' : ', and ') : ', ' });
    }
    parts.push({ kind: 'blank', name });
  });
  parts.push({ kind: 'text', text: '.' });
  return parts;
}

/** The sentence as plain text, for screen readers and notifications. */
export function blankSentenceText(blanks: readonly string[]): string {
  return blankSentence(blanks)
    .map((part) => (part.kind === 'text' ? part.text : part.name))
    .join('');
}

/** "1 blank" / "3 blanks". */
export function blankCountLabel(count: number): string {
  return count === 1 ? '1 blank' : `${count} blanks`;
}
