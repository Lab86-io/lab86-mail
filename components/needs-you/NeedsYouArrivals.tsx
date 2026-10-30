'use client';

import { KeyRound } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { useClientStore } from '@/lib/client-state';
import type { ObligationView } from '@/lib/obligations/contract';
import { laterOptions } from '@/lib/obligations/groups';
import { dueSentence, kindLabel, spacedCode } from '@/lib/obligations/labels';
import { postObligationAction, requestNeedsYouItem, useNeedsYouSnapshot } from './data';
import { NeedsYouGate } from './NeedsYouGate';
import { sonnerNeedsYouNotifier } from './NeedsYouView';
import { useNeedsYou } from './useNeedsYou';

/** The toast stays this long. */
export const ARRIVAL_TOAST_MS = 8_000;
/** An item older than this that enters Now (an overdue item) does not toast. */
export const ARRIVAL_WINDOW_MS = 15 * 60_000;

/** "Dana Whitfield asks you to confirm…": the asker, then the title in the same breath. */
export function arrivalSentence(obligation: Pick<ObligationView, 'asker' | 'title'>): string {
  const title = obligation.title.trim();
  const joined = /^[A-Z][a-z]/.test(title) ? title[0].toLowerCase() + title.slice(1) : title;
  return `${obligation.asker} ${joined}`;
}

export interface NeedsYouToastProps {
  obligation: ObligationView;
  now: number;
  timezone: string;
  onOpen: () => void;
  onLater: () => void;
  onCopy: () => void;
}

/** The in-app toast for a new Now item. A code shows the code and Copy code. */
export function NeedsYouToast({ obligation, now, timezone, onOpen, onLater, onCopy }: NeedsYouToastProps) {
  const code = obligation.kind === 'code' ? obligation.code : null;
  const source = ['Mail', kindLabel(obligation), dueSentence(obligation, now, timezone)]
    .filter(Boolean)
    .join(' · ');
  return (
    <div
      role="status"
      data-needs-you-toast={obligation.id}
      className="corner-smooth flex w-full items-center gap-3.5 rounded-ui border border-[var(--color-border)] bg-[var(--color-surface-float)] py-3 pl-4 pr-3.5 shadow-[var(--shadow-pop)]"
    >
      {code ? (
        <span
          aria-hidden
          className="grid size-6 shrink-0 place-items-center rounded-full border border-[var(--color-avatar-ring)] bg-[var(--color-control)] text-[var(--color-text-muted)]"
        >
          <KeyRound className="size-3" />
        </span>
      ) : (
        <Avatar name={obligation.asker} size={24} />
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] leading-[18px] text-[var(--color-text)]">
          {code ? (
            <>
              <b className="font-display font-medium">{obligation.asker}</b> sent a code:{' '}
              <span className="font-medium tracking-[0.06em] tabular-nums">{spacedCode(code.value)}</span>
            </>
          ) : (
            <>
              <b className="font-display font-medium">{obligation.asker}</b>{' '}
              {arrivalSentence(obligation).slice(obligation.asker.length + 1)}
            </>
          )}
        </span>
        <span className="mt-0.5 block text-[11.5px] text-[var(--color-text-muted)]">{source}</span>
      </span>
      <span className="flex shrink-0 gap-1">
        {code ? (
          <Button variant="outline" size="sm" onClick={onCopy}>
            Copy code
          </Button>
        ) : (
          <>
            <Button variant="outline" size="sm" onClick={onOpen}>
              Open
            </Button>
            <Button variant="ghost" size="sm" onClick={onLater}>
              Later
            </Button>
          </>
        )}
      </span>
    </div>
  );
}

const TOAST_STYLE = { width: 'min(560px, calc(100vw - 32px))' } as const;

export function showArrivalToast(
  obligation: ObligationView,
  now: number,
  timezone: string,
  handlers: { onOpen: () => void; onLater: () => void; onCopy: () => void },
) {
  toast.custom(
    (id) => (
      <NeedsYouToast
        obligation={obligation}
        now={now}
        timezone={timezone}
        onOpen={() => {
          toast.dismiss(id);
          handlers.onOpen();
        }}
        onLater={() => {
          toast.dismiss(id);
          handlers.onLater();
        }}
        onCopy={() => {
          toast.dismiss(id);
          handlers.onCopy();
        }}
      />
    ),
    { duration: ARRIVAL_TOAST_MS, style: TOAST_STYLE },
  );
}

/** The ids of the Now obligations that are new since `seen`, and young enough to toast. */
export function newArrivals(
  nowEntries: readonly ObligationView[],
  seen: ReadonlySet<string>,
  nowMs: number,
): ObligationView[] {
  return nowEntries.filter((item) => !seen.has(item.id) && item.createdAt >= nowMs - ARRIVAL_WINDOW_MS);
}

function ArrivalsInner() {
  const { enabled, isLoading, groups, nowMs, snapshot } = useNeedsYou();
  const setPrimaryView = useClientStore((state) => state.setPrimaryView);
  const seen = useRef<Set<string> | null>(null);
  const timezone = snapshot?.timezone ?? 'UTC';

  useEffect(() => {
    if (!enabled || isLoading) return;
    const current = (groups.find((group) => group.id === 'now')?.entries ?? []).flatMap((entry) =>
      entry.type === 'obligation' ? [entry.obligation] : [],
    );
    if (!seen.current) {
      seen.current = new Set(current.map((item) => item.id));
      return;
    }
    const fresh = newArrivals(current, seen.current, nowMs);
    for (const item of current) seen.current.add(item.id);
    for (const item of fresh) {
      showArrivalToast(item, nowMs, timezone, {
        onOpen: () => {
          requestNeedsYouItem(item.id);
          setPrimaryView('notifications');
        },
        onLater: () => {
          const option = laterOptions(Date.now(), timezone)[0];
          void postObligationAction(item.id, { action: 'later', until: option.until }).then(
            (response) => {
              if (response.undoUntil) {
                sonnerNeedsYouNotifier.undo({
                  title: 'Later',
                  description: `Back ${option.label.toLowerCase()}.`,
                  until: response.undoUntil,
                  onUndo: async () => {
                    await postObligationAction(item.id, { action: 'undo' });
                  },
                });
              }
            },
            () => sonnerNeedsYouNotifier.error('Could not save this change.'),
          );
        },
        onCopy: () => {
          const value = item.code?.value.replace(/\s+/g, '');
          if (value) {
            void navigator.clipboard
              .writeText(value)
              .then(() => sonnerNeedsYouNotifier.info('Copied'))
              .catch(() => sonnerNeedsYouNotifier.error('Could not copy the code.'));
          }
        },
      });
    }
  }, [enabled, isLoading, groups, nowMs, timezone, setPrimaryView]);

  return null;
}

/**
 * Reads only the snapshot first. A user outside the flag never mounts the
 * inner part, so the shell starts no second Albatross notification read.
 */
function ArrivalsWhenEnabled() {
  const snapshot = useNeedsYouSnapshot();
  return snapshot?.enabled ? <ArrivalsInner /> : null;
}

/** Mounted once in the shell: it toasts a new Now item while the app is open. */
export function NeedsYouArrivals() {
  return (
    <NeedsYouGate fallback={null}>
      <ArrivalsWhenEnabled />
    </NeedsYouGate>
  );
}
