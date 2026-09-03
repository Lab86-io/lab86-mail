'use client';

import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export interface Milestone {
  id: string;
  title: string;
  done: boolean;
  doneAt?: number;
  order: number;
}

export type MilestoneState = 'done' | 'current' | 'open';

export interface MilestoneRow {
  id?: string;
  title: string;
}

export const MILESTONES_EMPTY_LINE = 'Add the first milestone.';
export const MILESTONES_SAVE_ERROR = 'Could not save the milestones. Try again.';

/** The rail in order. The first open milestone is the current one. */
export function railStates(milestones: Milestone[]): Array<{ milestone: Milestone; state: MilestoneState }> {
  const rows = [...milestones].sort((a, b) => a.order - b.order);
  let currentSeen = false;
  return rows.map((milestone) => {
    if (milestone.done) return { milestone, state: 'done' as const };
    if (!currentSeen) {
      currentSeen = true;
      return { milestone, state: 'current' as const };
    }
    return { milestone, state: 'open' as const };
  });
}

/** "Done Aug 12" under a done milestone, "Next" under the current one, nothing under the rest. */
export function milestoneLine(milestone: Milestone, state: MilestoneState, locale = 'en-US'): string | null {
  if (state === 'current') return 'Next';
  if (state !== 'done') return null;
  if (typeof milestone.doneAt !== 'number') return 'Done';
  return `Done ${new Date(milestone.doneAt).toLocaleDateString(locale, { month: 'short', day: 'numeric' })}`;
}

/** The rail as plain text, one milestone per line, for the editor. */
export function milestonesToText(milestones: Milestone[]): string {
  return railStates(milestones)
    .map((row) => row.milestone.title)
    .join('\n');
}

/**
 * The editor text as `setMilestones` rows. A line that matches an existing
 * title keeps that milestone's id, once, so a reorder does not reopen it.
 */
export function milestoneRowsFromText(text: string, existing: Milestone[]): MilestoneRow[] {
  const unused = new Map<string, string[]>();
  for (const milestone of existing) {
    const key = milestone.title.trim().toLowerCase();
    unused.set(key, [...(unused.get(key) ?? []), milestone.id]);
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*•]\s+/, '').trim())
    .filter(Boolean)
    .map((title) => {
      const ids = unused.get(title.toLowerCase());
      const id = ids?.shift();
      return id ? { id, title } : { title };
    });
}

/**
 * The vertical rail. Twelve-pixel circles joined by a one-pixel line. Done
 * circles are filled, the current one carries a ring, the rest are hollow.
 * A click on a circle toggles it.
 */
export function MilestoneRail({
  milestones,
  onToggle,
  busyIds,
}: {
  milestones: Milestone[];
  onToggle: (id: string) => void;
  busyIds?: ReadonlySet<string>;
}) {
  const rows = railStates(milestones);
  return (
    <ol aria-label="Milestones" data-milestone-rail className="m-0 list-none p-0">
      {rows.map(({ milestone, state }, index) => {
        const last = index === rows.length - 1;
        const line = milestoneLine(milestone, state);
        const busy = busyIds?.has(milestone.id);
        return (
          <li
            key={milestone.id}
            data-milestone={milestone.id}
            data-milestone-state={state}
            className={cn('relative flex items-start gap-3', !last && 'pb-5', busy && 'opacity-55')}
          >
            {!last ? (
              <span
                aria-hidden
                data-rail-line={state === 'done' ? 'filled' : 'open'}
                className={cn(
                  'absolute bottom-0 left-[5.5px] top-[18px] w-px transition-colors duration-[var(--duration-moderate)] motion-reduce:transition-none',
                  state === 'done' ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border)]',
                )}
              />
            ) : null}
            <button
              type="button"
              aria-pressed={milestone.done}
              aria-label={milestone.done ? `Reopen ${milestone.title}` : `Complete ${milestone.title}`}
              disabled={busy}
              onClick={() => onToggle(milestone.id)}
              className={cn(
                'relative mt-[3px] flex size-3 shrink-0 items-center justify-center rounded-full bg-[var(--color-bg)]',
                'transition-[box-shadow,border-color] duration-[var(--duration-normal)]',
                state === 'done'
                  ? 'border border-[var(--color-accent)]'
                  : state === 'current'
                    ? 'border-2 border-[var(--color-accent)]'
                    : 'border border-[var(--color-border-strong)] hover:border-[var(--color-accent)]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/40',
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'size-3 rounded-full bg-[var(--color-accent)] transition-transform duration-[var(--duration-normal)] ease-[var(--ease-enter)] motion-reduce:transition-none',
                  state === 'done' ? 'scale-100' : 'scale-0',
                )}
              />
            </button>
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  'font-serif text-[16px] font-semibold leading-snug',
                  state === 'done' && 'text-[var(--color-text-muted)]',
                )}
              >
                {milestone.title}
              </p>
              {line ? (
                <p
                  className={cn(
                    'mt-0.5 text-[12px]',
                    state === 'current' ? 'text-[var(--color-accent-3)]' : 'text-[var(--color-text-faint)]',
                  )}
                >
                  {line}
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The rail as a text area, one milestone per line. Enter saves. Shift+Enter
 * starts a new line. Escape cancels.
 */
export function MilestoneEditor({
  milestones,
  onSave,
  onCancel,
  saving = false,
  error = null,
}: {
  milestones: Milestone[];
  onSave: (rows: MilestoneRow[]) => void;
  onCancel: () => void;
  saving?: boolean;
  error?: string | null;
}) {
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(() => milestonesToText(milestones));
  useEffect(() => {
    const node = areaRef.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
  }, []);

  const save = () => onSave(milestoneRowsFromText(text, milestones));
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      save();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  };
  const lines = Math.max(3, text.split('\n').length + 1);

  return (
    <div data-milestone-editor>
      <textarea
        ref={areaRef}
        aria-label="Milestones, one per line"
        value={text}
        rows={lines}
        disabled={saving}
        placeholder="One milestone per line"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKey}
        className={cn(
          'w-full resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-serif text-[15px] leading-7 outline-none',
          'placeholder:font-sans placeholder:text-[13px] placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)]',
        )}
      />
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          disabled={saving}
          onClick={save}
          className="text-[12.5px] font-medium text-[var(--color-accent)] disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={onCancel}
          className="text-[12.5px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          Cancel
        </button>
        <span className="text-[11.5px] text-[var(--color-text-faint)]">
          Enter saves. Shift+Enter adds a line.
        </span>
      </div>
      {error ? <p className="mt-2 text-[11.5px] text-[var(--color-danger)]">{error}</p> : null}
    </div>
  );
}
