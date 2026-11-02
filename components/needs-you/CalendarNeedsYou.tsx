'use client';

// Needs you on the calendar (docs/research/needs-you-web-2-design-2026-11-02.md).
// The `rsvp` and `prepare` items of an event show in the event dialog with
// their actions, and the week and day block carries one small mark. One
// snapshot read at the calendar surface; the blocks read a context.

import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ObligationView } from '@/lib/obligations/contract';
import { laterOptions } from '@/lib/obligations/groups';
import { kindLabel } from '@/lib/obligations/labels';
import { calendarEventKey, obligationsByEvent } from '@/lib/obligations/surfaces';
import { cn } from '@/lib/utils';
import { useNeedsYouSnapshot } from './data';
import { NeedsYouGate } from './NeedsYouGate';
import { useNowMs } from './useNeedsYou';
import { type ObligationPost, useObligationActions } from './useObligationActions';

export const CALENDAR_NEEDS_YOU_COPY = {
  kicker: 'Needs you',
  yes: 'Yes',
  no: 'No',
  maybe: 'Maybe',
  done: 'Done',
  later: 'Later',
  rsvpNote: 'The answer goes to your calendar. It has no Undo.',
  prepareNote: 'Done closes this. Undo for 10 seconds.',
} as const;

interface CalendarNeedsYouValue {
  byEvent: ReadonlyMap<string, ObligationView[]>;
  now: number;
  timezone: string;
  post?: ObligationPost;
}

const CalendarNeedsYouContext = createContext<CalendarNeedsYouValue | null>(null);

/** The pure provider: the preview gives it items; the connected one reads the snapshot. */
export function CalendarNeedsYouItems({
  items,
  now,
  timezone,
  post,
  children,
}: {
  items: readonly ObligationView[];
  now: number;
  timezone: string;
  post?: ObligationPost;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({ byEvent: obligationsByEvent(items, now), now, timezone, post }),
    [items, now, timezone, post],
  );
  return <CalendarNeedsYouContext.Provider value={value}>{children}</CalendarNeedsYouContext.Provider>;
}

function ConnectedItems({ children }: { children: ReactNode }) {
  const snapshot = useNeedsYouSnapshot();
  const nowMs = useNowMs(60_000);
  if (!snapshot?.enabled) return <>{children}</>;
  return (
    <CalendarNeedsYouItems items={snapshot.items} now={nowMs} timezone={snapshot.timezone}>
      {children}
    </CalendarNeedsYouItems>
  );
}

/** Wraps the calendar surface. A user outside the flag gets the children as they are. */
export function CalendarNeedsYouProvider({ children }: { children: ReactNode }) {
  return (
    <NeedsYouGate fallback={children}>
      <ConnectedItems>{children}</ConnectedItems>
    </NeedsYouGate>
  );
}

/** The open items of one event, or an empty list outside the flag. */
export function useEventObligations(
  accountId: string | undefined,
  eventId: string | undefined,
): ObligationView[] {
  const value = useContext(CalendarNeedsYouContext);
  if (!value || !accountId || !eventId) return [];
  return value.byEvent.get(calendarEventKey(accountId, eventId)) ?? [];
}

/** One small accent ring at the right of a block title: the event has an open item. */
export function EventNeedsYouMark({
  accountId,
  eventId,
  className,
}: {
  accountId: string | undefined;
  eventId: string | undefined;
  className?: string;
}) {
  const items = useEventObligations(accountId, eventId);
  if (!items.length) return null;
  return (
    <span
      role="img"
      aria-label={`Needs you: ${items[0].title}`}
      title={`Needs you: ${items[0].title}`}
      data-needs-you-event-mark
      className={cn('ml-auto size-2 shrink-0 rounded-full border-[1.5px] border-current', className)}
    />
  );
}

/** The item card in the event dialog: the sentence, why, and Yes/No/Maybe or Done/Later. */
export function EventNeedsYou({
  accountId,
  eventId,
}: {
  accountId: string | undefined;
  eventId: string | undefined;
}) {
  const value = useContext(CalendarNeedsYouContext);
  const items = useEventObligations(accountId, eventId);
  const actions = useObligationActions({ post: value?.post });
  const live = useMemo(() => actions.merge(items), [actions, items]);
  if (!value || !live.length) return null;
  const options = laterOptions(value.now, value.timezone);
  return (
    <div data-event-needs-you className="space-y-3">
      {live.map((item) => {
        const closed = item.state !== 'open' && item.state !== 'snoozed';
        // One request at a time across the dialog: an event can hold two items.
        const busy = actions.busyId !== null;
        const error = actions.error?.id === item.id ? actions.error.text : null;
        return (
          <div
            key={item.id}
            data-event-obligation={item.id}
            className="corner-smooth surface-accent rounded-ui border border-[var(--surface-border)] bg-[var(--color-bg-elevated)] px-3.5 py-3"
          >
            <p className="flex items-baseline gap-2 text-[11px] font-semibold text-[var(--color-accent)]">
              {CALENDAR_NEEDS_YOU_COPY.kicker}
              <span className="font-normal text-[var(--color-text-muted)]">{kindLabel(item)}</span>
            </p>
            <p className="mt-1 text-pretty font-display text-[15px] font-medium leading-snug text-[var(--color-text)]">
              {item.title}
            </p>
            {item.why ? (
              <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">{item.why}</p>
            ) : null}
            {error ? (
              <p role="alert" className="mt-2 text-[12px] text-[var(--color-danger)]">
                {error}
              </p>
            ) : null}
            {closed ? (
              <p className="mt-2 text-[12px] font-medium text-[var(--color-success)]">
                {item.kind === 'rsvp' ? 'Answered' : 'Done'}
              </p>
            ) : (
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                {item.kind === 'rsvp' ? (
                  <>
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => void actions.act(item, { action: 'rsvp', response: 'yes' })}
                    >
                      {CALENDAR_NEEDS_YOU_COPY.yes}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void actions.act(item, { action: 'rsvp', response: 'no' })}
                    >
                      {CALENDAR_NEEDS_YOU_COPY.no}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void actions.act(item, { action: 'rsvp', response: 'maybe' })}
                    >
                      {CALENDAR_NEEDS_YOU_COPY.maybe}
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => void actions.act(item, { action: 'done' })}
                  >
                    {CALENDAR_NEEDS_YOU_COPY.done}
                  </Button>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="ghost" disabled={busy}>
                      {CALENDAR_NEEDS_YOU_COPY.later}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {options.map((option) => (
                      <DropdownMenuItem
                        key={option.id}
                        onSelect={() => void actions.act(item, { action: 'later', until: option.until })}
                      >
                        {option.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <span className="ml-auto text-[11px] text-[var(--color-text-faint)]">
                  {item.kind === 'rsvp'
                    ? CALENDAR_NEEDS_YOU_COPY.rsvpNote
                    : CALENDAR_NEEDS_YOU_COPY.prepareNote}
                </span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
