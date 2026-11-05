'use client';

import { createContext } from 'react';
import type { DailyReportWorthKnowing } from '@/lib/shared/types';

/**
 * The facts of the current edition. The live page mounts above the report, so
 * the report gives them through this context at the place the page renders.
 */
export const TodayWorthKnowing = createContext<readonly DailyReportWorthKnowing[] | undefined>(undefined);

/** At most two short facts from the morning. Most days can have none, and then this takes no space. */
export function WorthKnowing({ items }: { items: readonly DailyReportWorthKnowing[] | undefined }) {
  const shown = (items ?? []).slice(0, 2);
  if (!shown.length) return null;
  return (
    <section data-today-worth-knowing aria-label="Worth knowing" className="min-w-0">
      <h2 className="border-b border-[var(--color-border)] pb-2 font-display text-[17px] font-medium tracking-tight text-[var(--color-text)]">
        Worth knowing
      </h2>
      <ul>
        {shown.map((item) => (
          <li key={item.title} className="pt-3.5 text-[14px] leading-[21px] text-[var(--color-text-muted)]">
            <span className="font-medium text-[var(--color-text)]">{item.title}</span> {item.line}
          </li>
        ))}
      </ul>
    </section>
  );
}
