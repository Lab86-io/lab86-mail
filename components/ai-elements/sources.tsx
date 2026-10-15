'use client';

// From the @ai-elements registry (sources). Restyled to the app tokens: the
// sources are quiet chips in one row that wraps, the trigger is the "+N" chip
// after the open ones (no book icon, no "Used N sources" line), and the
// content is the rest of the row. No open or close animation: motion is kept
// for the arrival of a message (design critique, 2026-10-15).

import type { ComponentProps } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

export type SourcesProps = ComponentProps<typeof Collapsible>;

/** The row: chips, then the "+N" trigger, then the folded chips in the same row. */
export const Sources = ({ className, ...props }: SourcesProps) => (
  <Collapsible data-slot="sources" className={cn('contents', className)} {...props} />
);

export const SOURCE_CHIP_CLASS =
  'inline-flex h-[22px] max-w-[280px] min-w-0 items-center gap-1.5 rounded-[7px] bg-[var(--color-control)] px-2 text-[11.5px] leading-none text-[var(--color-text)]';

const SOURCE_CHIP_BUTTON_CLASS =
  'hover:bg-[var(--color-control-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--color-bg)]';

export type SourcesTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  count: number;
};

/** The "+N" chip. It hides once the row is open. */
export const SourcesTrigger = ({ className, count, children, ...props }: SourcesTriggerProps) => (
  <CollapsibleTrigger
    data-slot="sources-trigger"
    className={cn(
      SOURCE_CHIP_CLASS,
      SOURCE_CHIP_BUTTON_CLASS,
      'text-[var(--color-text-muted)] data-[state=open]:hidden',
      className,
    )}
    aria-label={`Show ${count} more sources`}
    {...props}
  >
    {children ?? <span>+{count}</span>}
  </CollapsibleTrigger>
);

export type SourcesContentProps = ComponentProps<typeof CollapsibleContent>;

export const SourcesContent = ({ className, ...props }: SourcesContentProps) => (
  <CollapsibleContent data-slot="sources-content" className={cn('contents', className)} {...props} />
);

export type SourceProps = Omit<ComponentProps<'button'>, 'title'> & {
  /** The title of the source, cut for the chip. */
  text: string;
  /** The locator after the title, in the muted voice. */
  locator?: string | null;
  /** The full title (and the URL) for the tooltip. */
  title?: string;
  /** A web link: the chip is an anchor that opens a new tab. */
  href?: string;
  /** No press does anything: the chip is text. */
  inert?: boolean;
};

/** One chip: the title, then the locator. An anchor for a web page, a button for the rest. */
export const Source = ({ text, locator, title, href, inert, className, children, ...props }: SourceProps) => {
  const body = children ?? (
    <>
      <span className="truncate">{text}</span>
      {locator ? <span className="shrink-0 text-[var(--color-text-faint)]">{locator}</span> : null}
    </>
  );
  if (href) {
    return (
      <a
        data-slot="source"
        className={cn(SOURCE_CHIP_CLASS, SOURCE_CHIP_BUTTON_CLASS, className)}
        href={href}
        rel="noopener noreferrer"
        target="_blank"
        title={title}
        aria-label={props['aria-label']}
      >
        {body}
      </a>
    );
  }
  if (inert) {
    return (
      <span data-slot="source" className={cn(SOURCE_CHIP_CLASS, className)} title={title}>
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      data-slot="source"
      className={cn(SOURCE_CHIP_CLASS, SOURCE_CHIP_BUTTON_CLASS, className)}
      title={title}
      {...props}
    >
      {body}
    </button>
  );
};
