'use client';

import type { DailyReportWorthKnowing } from '@/lib/shared/types';

/** At most two short facts from the morning. Most days can have none, and then this takes no space. */
export function WorthKnowing({ items }: { items: readonly DailyReportWorthKnowing[] | undefined }) {
  const shown = (items ?? []).slice(0, 2);
  if (!shown.length) return null;
  return (
    <section data-today-worth-knowing aria-label="Worth knowing" className="@container">
      <h2 className="border-b border-[var(--color-border)] pb-2 font-display text-[17px] font-medium tracking-tight text-[var(--color-text)]">
        Worth knowing
      </h2>
      <ul className="grid gap-x-12 @[720px]:grid-cols-2">
        {shown.map((item) => (
          <li key={item.title} className="py-3 text-[14px] leading-[21px] text-[var(--color-text-muted)]">
            <span className="font-medium text-[var(--color-text)]">{item.title}</span> {item.line}
          </li>
        ))}
      </ul>
    </section>
  );
}
