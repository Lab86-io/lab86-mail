'use client';

import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { StepVerification } from '@/lib/albatross/step-verification';
import { STEP_VERIFICATION_LABEL } from '@/lib/albatross/step-verification';
import { cn } from '@/lib/utils';

export type GuidedStepMode = 'agent_does' | 'agent_drafts' | 'you_do_observed' | 'you_do_offline';

export interface GuidedStep {
  id: string;
  title: string;
  detail?: string | null;
  url?: string | null;
  knows: string[];
  needsYou: string[];
  done?: boolean;
  mode?: GuidedStepMode | null;
  doneWhen?: string | null;
  evidenceKind?: string | null;
  verification?: StepVerification | null;
}

export interface GuidedSession {
  sessionId: string;
  status: 'starting' | 'agent' | 'user' | 'verifying' | 'ended' | 'failed' | string;
  statusDetail?: string | null;
  liveViewUrl: string;
}

/** The one status line above the shared browser. It never overstates. */
export function guidedSessionStatusLine(session: GuidedSession): string {
  switch (session.status) {
    case 'starting':
      return 'Opening a shared browser…';
    case 'agent':
      return 'Albatross is working on the page.';
    case 'verifying':
      return 'Checking the page…';
    default:
      return session.statusDetail || 'Your turn on the page. Albatross follows along.';
  }
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
 * recede. Done rows carry how they were verified — a check is never dressed up
 * as more than it earned.
 */
export function GuidedStepPane({
  steps,
  activeId,
  onSelect,
  onExit,
  onComplete,
  onDiscuss,
  savingIds,
  error,
  session,
  sessionBusy,
  onStartSession,
  onVerifySession,
  onEndSession,
}: {
  steps: GuidedStep[];
  activeId?: string;
  onSelect?: (id: string) => void;
  onExit?: () => void;
  onComplete?: (id: string, note?: string) => void | Promise<boolean>;
  onDiscuss?: () => void;
  savingIds?: ReadonlySet<string>;
  error?: string | null;
  session?: GuidedSession | null;
  sessionBusy?: boolean;
  onStartSession?: (id: string) => void;
  onVerifySession?: (id: string) => void;
  onEndSession?: () => void;
}) {
  const active = steps.find((step) => step.id === (activeId || steps[0]?.id)) || steps[0];
  const [note, setNote] = useState('');
  const [noteStepId, setNoteStepId] = useState<string | undefined>(active?.id);
  // A note typed for one step must never ride along to the next one.
  if (active && noteStepId !== active.id) {
    setNoteStepId(active.id);
    setNote('');
  }
  if (!active) return null;
  const offline = active.mode === 'you_do_offline' || (!active.mode && !active.url);
  const saving = savingIds?.has(active.id);

  const complete = () => {
    const stepId = active.id;
    // The note survives a failed save so the user can retry without retyping.
    void Promise.resolve(onComplete?.(stepId, note.trim() || undefined)).then((ok) => {
      if (ok !== false) {
        setNote((current) => (noteStepId === stepId ? '' : current));
      }
    });
  };

  return (
    <section className="flex h-full min-h-0">
      {/* Left: the ledger of steps. Its own chrome — a tinted rail, numbered,
          with the current step raised out of the column. */}
      <aside className="flex w-[300px] shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-bg-subtle)]">
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2.5">
          {onExit ? (
            <Button type="button" size="xs" variant="ghost" onClick={onExit}>
              Back
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
                  aria-busy={savingIds?.has(step.id) || undefined}
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
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        'block text-[12.5px] leading-snug',
                        current ? 'font-medium' : 'text-[var(--color-text-muted)]',
                      )}
                    >
                      {step.title}
                    </span>
                    {step.done && step.verification ? (
                      <span
                        className={cn(
                          'mt-0.5 block text-[10.5px]',
                          step.verification.level === 'reported'
                            ? 'text-[var(--color-text-faint)]'
                            : 'text-[var(--color-success)]',
                        )}
                      >
                        {STEP_VERIFICATION_LABEL[step.verification.level]}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>

        <div className="border-t border-[var(--color-border)] p-3">
          <p className="text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">
            Albatross keeps the instructions and progress here. You stay in control of every external site.
          </p>
        </div>
      </aside>

      {/* Right: the site itself, with the step's own briefing above it. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="border-b border-[var(--color-border)] px-4 py-3">
          <h2 className="font-serif text-[16px] font-semibold">{active.title}</h2>
          {active.detail ? (
            <p className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
              {active.detail}
            </p>
          ) : null}
          {active.doneWhen ? (
            <p className="mt-1.5 max-w-2xl text-[12px] leading-relaxed">
              <span className="text-[var(--color-text-faint)]">Done when</span>{' '}
              <span className="text-[var(--color-text-muted)]">{active.doneWhen}</span>
            </p>
          ) : null}
          {!active.done && active.evidenceKind === 'mail_confirmation' ? (
            <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-[var(--color-text-muted)]">
              The confirmation lands in Mail. Albatross checks this step off when it arrives.
            </p>
          ) : null}
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
                      <li key={item} className="text-[12px]">
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </div>
          {!active.done && offline && onComplete ? (
            <div className="mt-3">
              <label htmlFor="guided-step-note" className="text-[11.5px] text-[var(--color-text-faint)]">
                What came of it? The answer feeds the rest of the plan.
              </label>
              <textarea
                id="guided-step-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={2}
                placeholder="The fee is $120. The office wants the packet by Friday."
                className="mt-1 w-full resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5 text-[12.5px] leading-relaxed outline-none focus:border-[var(--color-accent)]"
              />
            </div>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--color-border)]/70 pt-3">
            {!active.done && onComplete ? (
              <Button type="button" size="sm" disabled={saving} onClick={complete}>
                {saving ? 'Saving…' : 'Mark this step done'}
              </Button>
            ) : (
              <span className="text-[12px] text-[var(--color-text-muted)]">
                {active.verification
                  ? `This step is complete. ${STEP_VERIFICATION_LABEL[active.verification.level]}${
                      active.verification.evidenceTitle ? ` — ${active.verification.evidenceTitle}` : ''
                    }.`
                  : 'This step is complete.'}
              </span>
            )}
            {onDiscuss ? (
              <Button type="button" size="sm" variant="outline" onClick={onDiscuss}>
                Discuss this
              </Button>
            ) : null}
          </div>
          {error ? <p className="mt-2 text-[11.5px] text-[var(--color-danger)]">{error}</p> : null}
        </div>

        <div className="min-h-0 flex-1 bg-[var(--color-bg-subtle)] p-3">
          {session && session.status !== 'ended' && session.status !== 'failed' ? (
            <div className="flex h-full flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
              <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2">
                <span
                  aria-hidden
                  className={cn(
                    'size-2 shrink-0 rounded-full',
                    session.status === 'user'
                      ? 'bg-[var(--color-success)]'
                      : 'bg-[var(--color-accent)] animate-pulse',
                  )}
                />
                <span className="min-w-0 flex-1 truncate text-[12px]">
                  {guidedSessionStatusLine(session)}
                </span>
                {!active.done && onVerifySession ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={sessionBusy || session.status === 'verifying' || session.status === 'starting'}
                    onClick={() => onVerifySession(active.id)}
                  >
                    {session.status === 'verifying' ? 'Checking…' : 'Check the page'}
                  </Button>
                ) : null}
                {onEndSession ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={sessionBusy}
                    onClick={onEndSession}
                  >
                    Stop the shared browser
                  </Button>
                ) : null}
              </div>
              {/* The live view is the real browser, interactive. The user acts
                  here — logins and payments included — and Albatross only ever
                  reads the page state to verify doneWhen. */}
              <iframe
                title="Shared browser"
                src={session.liveViewUrl}
                sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
                allow="clipboard-read; clipboard-write"
                className="min-h-0 w-full flex-1 border-0"
              />
            </div>
          ) : active.url ? (
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
              <div className="grid flex-1 place-items-center px-6 text-center">
                <div className="max-w-sm">
                  {onStartSession ? (
                    <>
                      <p className="text-[13px] font-medium">Work on this page here.</p>
                      <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
                        Albatross opens a shared browser at this page, follows along, and checks the step off
                        when the page shows it is done. Anything private — passwords, payments — you type
                        yourself, straight into the site.
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        className="mt-3"
                        disabled={sessionBusy || active.done}
                        onClick={() => onStartSession(active.id)}
                      >
                        {sessionBusy ? 'Opening…' : 'Open the shared browser'}
                      </Button>
                      <p className="mt-3 text-[11.5px] leading-relaxed text-[var(--color-text-faint)]">
                        Or open the site in another tab and return to record the step when it is done.
                      </p>
                    </>
                  ) : (
                    <>
                      {/* Sites almost always refuse to be framed. Saying so beats
                          an empty box the user cannot explain. */}
                      <p className="text-[13px] font-medium">Open the site in another tab.</p>
                      <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
                        Most sites refuse to be embedded. Keep this guide beside the page, then return to
                        record the step when it is done.
                      </p>
                    </>
                  )}
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
