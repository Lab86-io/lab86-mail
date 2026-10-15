'use client';

// The messages a goal run wrote while it worked, with their sources
// (docs/research/goal-runs-web-design-2026-10-15.md, section 3.3). Each
// message is prose through the chat's Markdown renderer. Its sources are
// chips under it: the title, then a locator in the muted voice. The newest
// messages stay open; the older ones fold under "Earlier messages". A message
// that arrives while the block is on screen rises once (sd-rise); reduced
// motion shows it in place.

import { useRef, useState } from 'react';
import { Source, Sources, SourcesContent, SourcesTrigger } from '@/components/ai-elements/sources';
import { Markdown } from '@/components/ui/markdown';
import type { RunMessage, RunSource } from '@/lib/albatross/goal-run-contract';
import {
  type DocumentTab,
  formatRunTime,
  GOAL_RUN_COPY,
  SOURCE_CHIPS_OPEN,
  type SourceBehaviour,
  sourceChip,
  sourceChipName,
  visibleMessages,
} from '@/lib/albatross/goal-run-view';
import { cn } from '@/lib/utils';

export const MESSAGE_CLASS =
  'prose prose-sm max-w-none text-[13.5px] leading-relaxed text-[var(--color-text)] dark:prose-invert [&_a]:text-[var(--color-accent)] [&_p]:my-0 [&_ul]:my-1 [&_ol]:my-1';

export function RunMessages({
  messages,
  working,
  tabs = [],
  timeZone,
  onOpenSource,
  className,
}: {
  messages: readonly RunMessage[];
  /** The run is queued or in progress: six messages stay open instead of three. */
  working: boolean;
  /** The package tabs, so a source that is in the package opens its tab. */
  tabs?: readonly DocumentTab[];
  timeZone?: string;
  onOpenSource?: (behaviour: SourceBehaviour, source: RunSource) => void;
  className?: string;
}) {
  const [showAll, setShowAll] = useState(false);
  // The messages on screen at mount do not rise; only a message that arrives later does.
  const initial = useRef<Set<string> | null>(null);
  if (initial.current === null) initial.current = new Set(messages.map((message) => message.id));
  const { open, folded } = visibleMessages(messages, { working, showAll });
  if (!messages.length) return null;
  return (
    <section
      data-slot="run-messages"
      aria-label="Messages"
      className={cn('flex flex-col gap-2.5', className)}
    >
      {folded.length ? (
        <button
          type="button"
          data-slot="earlier-messages"
          aria-expanded={showAll}
          onClick={() => setShowAll(true)}
          className="group flex w-fit cursor-pointer items-center gap-1.5 text-left text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          <span>{GOAL_RUN_COPY.earlierMessages}</span>
          <span className="tabular-nums text-[var(--color-text-faint)]">{folded.length}</span>
          <span
            aria-hidden
            className="ml-0.5 inline-block size-[7px] -translate-y-[1px] rotate-[-45deg] border-r border-b border-current"
          />
        </button>
      ) : null}
      {open.map((message) => (
        <article
          key={message.id}
          data-slot="run-message"
          data-message-id={message.id}
          title={formatRunTime(message.at, undefined, timeZone)}
          className={cn(
            'flex min-w-0 flex-col gap-1.5',
            !initial.current?.has(message.id) &&
              'animate-[sd-rise_150ms_cubic-bezier(0.165,0.84,0.44,1)_both] motion-reduce:animate-none',
          )}
        >
          <Markdown className={MESSAGE_CLASS}>{message.text}</Markdown>
          <SourceChips sources={message.sources} tabs={tabs} onOpen={onOpenSource} />
        </article>
      ))}
    </section>
  );
}

/** The chips under a message: the first four, then "+N" for the rest. */
export function SourceChips({
  sources,
  tabs = [],
  onOpen,
  className,
}: {
  sources: readonly RunSource[];
  tabs?: readonly DocumentTab[];
  onOpen?: (behaviour: SourceBehaviour, source: RunSource) => void;
  className?: string;
}) {
  if (!sources.length) return null;
  const chips = sources.map((source) => ({ source, chip: sourceChip(source, tabs) }));
  const shown = chips.slice(0, SOURCE_CHIPS_OPEN);
  const rest = chips.slice(SOURCE_CHIPS_OPEN);
  const render = ({ source, chip }: (typeof chips)[number]) => {
    const name = sourceChipName(chip);
    if (chip.behaviour?.kind === 'open_url')
      return (
        <Source
          key={chip.key}
          text={chip.text}
          locator={chip.locator}
          title={chip.title}
          href={chip.behaviour.url}
          aria-label={name}
        />
      );
    const behaviour = chip.behaviour;
    if (!behaviour)
      return <Source key={chip.key} text={chip.text} locator={chip.locator} title={chip.title} inert />;
    return (
      <Source
        key={chip.key}
        text={chip.text}
        locator={chip.locator}
        title={chip.title}
        aria-label={name}
        onClick={() => onOpen?.(behaviour, source)}
      />
    );
  };
  return (
    <div data-slot="source-chips" className={cn('flex flex-wrap items-center gap-x-1.5 gap-y-1', className)}>
      {shown.map(render)}
      {rest.length ? (
        <Sources>
          <SourcesTrigger count={rest.length} />
          <SourcesContent>{rest.map(render)}</SourcesContent>
        </Sources>
      ) : null}
    </div>
  );
}
