import { DropCap } from '@/components/ui/drop-cap';

/** Give the existing account an editorial opening without inventing a summary
 * or dropping any source-backed prose. Older editions can be one long paragraph. */
export function narrativeProse(text: string): { lede: string; paragraphs: string[] } {
  const paragraphs = text
    .trim()
    .split(/\n\s*\n/)
    .filter(Boolean);
  const opening = paragraphs.shift() || '';
  if (opening.length <= 320) return { lede: opening, paragraphs };

  const first =
    new Intl.Segmenter('en', { granularity: 'sentence' }).segment(opening)[Symbol.iterator]().next().value
      ?.segment || opening;
  const rest = opening.slice(first.length).trim();
  return { lede: first.trim(), paragraphs: [...(rest ? [rest] : []), ...paragraphs] };
}

export function NarrativeProse({ text }: { text: string }) {
  const { lede, paragraphs } = narrativeProse(text);
  return (
    <div className="space-y-4 font-serif">
      <DropCap
        text={lede}
        className="text-[21px] font-normal leading-[1.55] tracking-[-0.015em] whitespace-pre-line sm:text-[23px]"
      />
      {paragraphs.length ? (
        <div data-narrative-body className="space-y-4 text-[16px] leading-[1.75] whitespace-pre-line">
          {paragraphs.map((paragraph, index) => (
            // Paragraph position is stable within this immutable edition.
            // biome-ignore lint/suspicious/noArrayIndexKey: duplicate paragraphs must remain distinct.
            <p key={index} className="indent-[1.5em]">
              {paragraph}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
