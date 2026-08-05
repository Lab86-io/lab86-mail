'use client';

import { ExternalLink, Hand, PanelLeftClose } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type GuideMode = 'guide' | 'with_me' | 'handle_it';

export const GUIDE_MODE_LABEL: Record<GuideMode, string> = {
  guide: 'Guide me',
  with_me: 'Do it with me',
  handle_it: 'Handle it',
};

export const GUIDE_MODE_NOTE: Record<GuideMode, string> = {
  guide: 'Albatross points at what to do. It fills nothing in and submits nothing.',
  with_me: 'Albatross fills what it knows. You approve anything that matters.',
  handle_it: 'Albatross completes low-risk, reversible steps on its own.',
};

export interface GuidedStep {
  id: string;
  title: string;
  url?: string | null;
  knows: string[];
  needsYou: string[];
  done?: boolean;
}

/**
 * Guided work.
 *
 * Real outcomes run through somebody else's website — an insurer, a government
 * form, an airline. This is the pane for that: the step on the left, the site
 * on the right, and a mode control that is really a consent control.
 *
 * The left rail is its own object, closer to a lesson panel than to the app's
 * list rows: a numbered ledger where the current step is raised and the rest
 * recede, so at a glance you can see where you are in something long.
 */
export function GuidedStepPane({
  steps,
  activeId,
  onSelect,
  onExit,
}: {
  steps: GuidedStep[];
  activeId?: string;
  onSelect?: (id: string) => void;
  onExit?: () => void;
}) {
  const [mode, setMode] = useState<GuideMode>('with_me');
  const active = steps.find((step) => step.id === (activeId || steps[0]?.id)) || steps[0];
  if (!active) return null;

  return (
    <section className="flex h-full min-h-0">
      {/* Left: the ledger of steps. Its own chrome — a tinted rail, numbered,
          with the current step raised out of the column. */}
      <aside className="flex w-[300px] shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-bg-subtle)]">
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2.5">
          {onExit ? (
            <Button type="button" size="xs" variant="ghost" onClick={onExit}>
              <PanelLeftClose className="size-3.5" /> Back
            </Button>
          ) : null}
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">Guided work</span>
        </div>

        <ol className="min-h-0 flex-1 overflow-y-auto p-2">
          {steps.map((step, index) => {
            const current = step.id === active.id;
            return (
              <li key={step.id}>
                <button
                  type="button"
                  onClick={() => onSelect?.(step.id)}
                  className={cn(
                    'flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                    current
                      ? 'bg-[var(--color-bg-elevated)] shadow-[var(--shadow-soft)]'
                      : 'hover:bg-[var(--color-bg-muted)]',
                    !current && step.done && 'opacity-60',
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'mt-[1px] grid size-5 shrink-0 place-items-center rounded-full text-[10.5px] font-medium',
                      step.done
                        ? 'bg-[var(--color-success)] text-white'
                        : current
                          ? 'bg-[var(--color-accent)] text-[var(--color-accent-foreground)]'
                          : 'border border-[var(--color-border-strong)] text-[var(--color-text-faint)]',
                    )}
                  >
                    {step.done ? '✓' : index + 1}
                  </span>
                  <span
                    className={cn(
                      'min-w-0 flex-1 text-[12.5px] leading-snug',
                      current ? 'font-medium' : 'text-[var(--color-text-muted)]',
                    )}
                  >
                    {step.title}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>

        <div className="border-t border-[var(--color-border)] p-3">
          <p className="text-[11.5px] text-[var(--color-text-faint)]">How much should Albatross do?</p>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {(['guide', 'with_me', 'handle_it'] as GuideMode[]).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={mode === option}
                onClick={() => setMode(option)}
                className={cn(
                  'rounded-full px-2.5 py-1 text-[11.5px] transition-colors',
                  mode === option
                    ? 'bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]'
                    : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-muted)]',
                )}
              >
                {GUIDE_MODE_LABEL[option]}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
            {GUIDE_MODE_NOTE[mode]}
          </p>
        </div>
      </aside>

      {/* Right: the site itself, with the step's own briefing above it. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="border-b border-[var(--color-border)] px-4 py-3">
          <h2 className="font-serif text-[16px] font-semibold">{active.title}</h2>
          {/* The pane is narrower than the viewport, so the columns follow the
              pane. `sm:` would split at a width this pane never has. */}
          <div className="@container mt-2">
            <div className="grid gap-3 @sm:grid-cols-2">
              {active.knows.length ? (
                <div>
                  <p className="text-[11.5px] text-[var(--color-text-faint)]">Albatross already has</p>
                  <ul className="mt-1 space-y-0.5">
                    {active.knows.map((item) => (
                      <li key={item} className="text-[12px] text-[var(--color-text-muted)]">
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {active.needsYou.length ? (
                <div>
                  <p className="text-[11.5px] text-[var(--color-text-faint)]">Only you can do</p>
                  <ul className="mt-1 space-y-0.5">
                    {active.needsYou.map((item) => (
                      <li key={item} className="flex items-start gap-1.5 text-[12px]">
                        <Hand className="mt-[3px] size-3 shrink-0 text-[var(--color-accent)]" aria-hidden />
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 bg-[var(--color-bg-subtle)] p-3">
          {active.url ? (
            <div className="flex h-full flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
              <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[var(--color-text-muted)]">
                  {active.url}
                </span>
                <a
                  href={active.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[11.5px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                >
                  Open it myself <ExternalLink className="size-3" aria-hidden />
                </a>
              </div>
              {/* Sites almost always refuse to be framed. Saying so beats an
                  empty box the user cannot explain. */}
              <div className="grid flex-1 place-items-center px-6 text-center">
                <div className="max-w-sm">
                  <p className="text-[13px] font-medium">Albatross opens this in its own browser.</p>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
                    Most sites refuse to be embedded, so the guided session runs beside this panel rather than
                    inside it. You can take over at any point.
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="grid h-full place-items-center rounded-xl border border-dashed border-[var(--color-border)] px-6 text-center">
              <p className="max-w-sm text-[13px] text-[var(--color-text-muted)]">
                This step does not happen on a website. Albatross will tell you when there is something to
                click.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
