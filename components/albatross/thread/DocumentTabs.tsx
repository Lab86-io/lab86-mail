'use client';

// The tab bar of document mode (docs/research/goal-runs-web-design-2026-10-15.md,
// §5.2): one tab per package item with a pane, in package order. A tab that
// still needs the user ends with a dot in the blank voice ("Still yours"); a
// sent draft ends with "Sent". One tab stop: Left and Right move, Home and
// End jump, Escape closes document mode. ⌥⌘[ and ⌥⌘] move from anywhere in
// document mode. "Close" is the one way out.

import { useEffect, useMemo, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { type DocumentTab, GOAL_RUN_COPY } from '@/lib/albatross/goal-run-view';
import { cn } from '@/lib/utils';

/** The next tab key for a bracket key: ⌥⌘] forward, ⌥⌘[ back. Null for any other key. */
export function tabHopKey(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'altKey' | 'ctrlKey' | 'shiftKey'>,
  keys: readonly string[],
  activeKey: string | null,
): string | null {
  if (!(event.metaKey || event.ctrlKey) || !event.altKey || event.shiftKey || keys.length < 2) return null;
  const forward = event.code === 'BracketRight' || event.key === ']';
  const back = event.code === 'BracketLeft' || event.key === '[';
  if (!forward && !back) return null;
  const index = Math.max(0, keys.indexOf(activeKey ?? ''));
  const next = forward ? (index + 1) % keys.length : (index - 1 + keys.length) % keys.length;
  return keys[next];
}

export function DocumentTabs({
  tabs,
  activeKey,
  sent = {},
  onSelect,
  onClose,
  className,
}: {
  tabs: readonly DocumentTab[];
  activeKey: string | null;
  /** The drafts this client knows went out, by draft id. */
  sent?: Readonly<Record<string, string>>;
  onSelect: (key: string) => void;
  onClose: () => void;
  className?: string;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const keys = useMemo(() => tabs.map((tab) => tab.key), [tabs]);

  // The active tab stays in view when the bar scrolls sideways.
  useEffect(() => {
    if (!activeKey) return;
    const active = listRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    active?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
  }, [activeKey]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const next = tabHopKey(event, keys, activeKey);
      if (!next) return;
      event.preventDefault();
      onSelect(next);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [keys, activeKey, onSelect]);

  const move = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!keys.length) return;
    const index = Math.max(0, keys.indexOf(activeKey ?? ''));
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = (index + 1) % keys.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + keys.length) % keys.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = keys.length - 1;
    else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (next === null) return;
    event.preventDefault();
    onSelect(keys[next]);
    requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    });
  };

  return (
    <div
      data-slot="document-tabs"
      className={cn(
        'flex h-[38px] shrink-0 items-stretch gap-0.5 border-b border-[var(--color-border)] pl-2 pr-2',
        className,
      )}
    >
      <div
        ref={listRef}
        role="tablist"
        aria-label="Items in the package"
        onKeyDown={move}
        className="flex min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto [scrollbar-width:none]"
      >
        {tabs.map((tab) => {
          const active = tab.key === activeKey;
          const sentAt = tab.pane.kind === 'draft' ? (sent[tab.pane.id] ?? null) : null;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              id={`document-tab-${tab.key}`}
              aria-selected={active}
              aria-controls="document-tab-panel"
              tabIndex={active ? 0 : -1}
              onClick={() => onSelect(tab.key)}
              title={tab.item.title}
              className={cn(
                '-mb-px inline-flex shrink-0 items-center gap-2 border-b-2 px-3 text-[12.5px] whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]',
                active
                  ? 'border-[var(--color-accent)] font-medium text-[var(--color-text)]'
                  : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
              )}
            >
              <span>{tab.label}</span>
              {sentAt ? (
                <span className="text-[11px] text-[var(--color-success)]">{GOAL_RUN_COPY.tabSent}</span>
              ) : tab.stillYours ? (
                <span
                  role="img"
                  aria-label={GOAL_RUN_COPY.stillYours}
                  title={GOAL_RUN_COPY.stillYours}
                  data-slot="tab-still-yours"
                  className="inline-block size-1.5 rounded-full bg-[var(--color-accent-3)]"
                />
              ) : null}
            </button>
          );
        })}
      </div>
      <Button type="button" size="xs" variant="ghost" className="self-center" onClick={onClose}>
        {GOAL_RUN_COPY.tabsClose}
      </Button>
    </div>
  );
}
