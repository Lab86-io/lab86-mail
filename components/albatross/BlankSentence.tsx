'use client';

// The user's part of a handoff, drawn as a form line: "Fill in ___, ___, and
// ___." with the field name under each line (docs/albatross-blank-design.md).
// Only the blanks use the highlight voice. Without blanks, the fallback text
// shows in the same display style.

import { blankSentence, blankSentenceText } from '@/lib/albatross/blanks';
import { cn } from '@/lib/utils';

export function BlankSentence({
  blanks,
  fallback,
  as: Tag = 'p',
  className,
}: {
  blanks: readonly string[];
  fallback?: string | null;
  /** "span" inside a button, where a paragraph is not allowed. */
  as?: 'p' | 'span';
  className?: string;
}) {
  // The sentence never reorders, so a part's place is its identity.
  const parts = blankSentence(blanks).map((part, place) => ({ ...part, id: `${part.kind}-${place}` }));
  const base = 'font-display font-normal tracking-[-0.01em] text-pretty text-[var(--color-text)]';
  if (!parts.length) {
    const text = fallback?.trim();
    return text ? (
      <Tag className={cn(base, 'text-[19px] leading-[1.4]', className)} data-blank-sentence="">
        {text}
      </Tag>
    ) : null;
  }
  return (
    <Tag className={cn(base, 'pb-2.5 text-[19px] leading-[1.9]', className)} data-blank-sentence="">
      <span className="sr-only">{blankSentenceText(blanks)}</span>
      {parts.map((part) =>
        part.kind === 'text' ? (
          <span key={part.id} aria-hidden="true">
            {part.text}
          </span>
        ) : (
          <Blank key={part.id} name={part.name} />
        ),
      )}
    </Tag>
  );
}

/**
 * The least width of a blank: 5.4 em, or the width of its field name (11 px
 * Geist is about 6.2 px for each character) when the name is longer.
 */
export function blankMinWidth(name: string): string {
  return `max(5.4em, ${Math.ceil(name.length * 6.2) + 12}px)`;
}

/**
 * One empty line with its field name under it. The line has no text inside,
 * so its bottom edge sits on the text baseline; the small drop puts the line
 * just under the letters, as on a paper form.
 */
function Blank({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      data-blank={name}
      style={{ minWidth: blankMinWidth(name) }}
      className="relative inline-block h-[0.9em] border-b-2 border-[var(--color-accent-3)] align-[-0.2em]"
    >
      <span className="absolute inset-x-0 top-[calc(100%+3px)] whitespace-nowrap text-center font-sans text-[11px] font-medium leading-none tracking-normal text-[var(--color-accent-3)]">
        {name}
      </span>
    </span>
  );
}
