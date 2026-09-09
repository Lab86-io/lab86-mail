'use client';

import { PenLine } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { NarrativeContextPacket } from '@/lib/narrative/context';

interface Props {
  to: string;
  subject: string;
  body: string;
  topic?: string;
  disabled?: boolean;
  onApply: (body: string) => void;
}

/** Changing the message invalidates every selection and pending draft. */
export function NarrativeDraftAssistant(props: Props) {
  return <DraftPanel key={JSON.stringify([props.to, props.subject, props.body, props.topic])} {...props} />;
}

function DraftPanel({ to, subject, body, topic, disabled, onApply }: Props) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [context, setContext] = useState<NarrativeContextPacket | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [phase, setPhase] = useState<'idle' | 'context' | 'draft'>('idle');
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    if (disabled) {
      pending.current?.abort();
      setPhase('idle');
      setDraft('');
    }
  }, [disabled]);

  async function loadContext() {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setPhase('context');
    setError('');
    setSelected([]);
    setContext(null);
    setDraft('');
    const params = new URLSearchParams({
      purpose: 'search',
      q: `${subject} ${to} ${instructions}`.slice(0, 240),
    });
    if (topic) params.set('topic', topic);
    try {
      const response = await fetch(`/api/narrative/context?${params}`, { signal: controller.signal });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || 'Context is unavailable. You can still draft without it.');
      if (!controller.signal.aborted) setContext(result);
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(failure instanceof Error ? failure.message : 'Could not load context.');
    } finally {
      if (!controller.signal.aborted) setPhase('idle');
    }
  }

  async function generate() {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setPhase('draft');
    setError('');
    setDraft('');
    try {
      const response = await fetch('/api/compose/draft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          to,
          subject,
          instructions: [instructions, body && `Existing draft:\n${body}`].filter(Boolean).join('\n\n'),
          contextIds: selected,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Drafting failed. Your message is unchanged.');
      if (!controller.signal.aborted) setDraft(result.draft);
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(failure instanceof Error ? failure.message : 'Drafting failed.');
    } finally {
      if (!controller.signal.aborted) setPhase('idle');
    }
  }

  function close() {
    pending.current?.abort();
    setOpen(false);
    setPhase('idle');
    setDraft('');
    setSelected([]);
    setContext(null);
    setError('');
  }

  return (
    <section className="border-t border-[var(--color-border)] px-4 py-2 text-xs">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          if (open) close();
          else {
            setOpen(true);
            void loadContext();
          }
        }}
      >
        <PenLine className="size-3.5" aria-hidden="true" /> Draft with context
      </Button>
      {open && (
        <div id={id} className="space-y-3 py-2">
          <label className="block space-y-1">
            <span>What should this email say?</span>
            <textarea
              value={instructions}
              disabled={phase === 'draft' || disabled}
              onChange={(event) => {
                setInstructions(event.target.value);
                setDraft('');
              }}
              maxLength={8000}
              rows={2}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-sm"
              placeholder="A short follow-up on the launch decision…"
            />
          </label>
          <div className="space-y-2">
            <p className="text-[var(--color-text-muted)]">
              Only select context you want used in this email. Nothing is sent until you send it.
            </p>
            {phase === 'context' && <p role="status">Finding related context…</p>}
            {context && (
              <p className="text-[11px] text-[var(--color-text-muted)]">
                {context.evidence.length
                  ? context.coverage
                  : context.enabled
                    ? 'No related evidence found. Try a more specific instruction and refresh.'
                    : 'Narrative memory is off. Drafting still works without it.'}
              </p>
            )}
            {context?.evidence.slice(0, 6).map((entry) => (
              <div key={entry.id} className="rounded-md border border-[var(--color-border)] p-2">
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={selected.includes(entry.id)}
                    disabled={phase === 'draft' || disabled}
                    onChange={(event) => {
                      setDraft('');
                      setSelected((items) =>
                        event.target.checked
                          ? [...items, entry.id]
                          : items.filter((item) => item !== entry.id),
                      );
                    }}
                  />
                  <span className="min-w-0">
                    <span className="font-medium">{entry.title}</span>
                    <span className="mt-1 block text-[var(--color-text-muted)]">{entry.text}</span>
                  </span>
                </label>
                <a
                  className="mt-1 inline-block text-[var(--color-accent)] underline"
                  href={`/narrative?id=${encodeURIComponent(entry.id)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Inspect source
                </a>
              </div>
            ))}
            <div className="flex items-center gap-3">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void loadContext()}
                disabled={phase !== 'idle' || disabled}
              >
                Refresh context
              </Button>
              <a
                className="text-[var(--color-text-muted)] underline"
                href="/narrative"
                target="_blank"
                rel="noopener noreferrer"
              >
                Memory settings
              </a>
            </div>
          </div>
          {error && (
            <p role="alert" className="text-[var(--color-text-muted)]">
              {error}
            </p>
          )}
          {phase === 'draft' && <p role="status">Writing a draft from your selected context…</p>}
          {draft && (
            <label className="block space-y-1">
              <span>Review before using</span>
              <textarea
                aria-label="Suggested email draft"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                rows={6}
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-sm"
              />
            </label>
          )}
          <div className="flex gap-2">
            {draft ? (
              <Button
                type="button"
                size="sm"
                disabled={disabled || phase !== 'idle'}
                onClick={() => {
                  onApply(draft);
                  close();
                }}
              >
                Use draft
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                disabled={
                  disabled ||
                  phase !== 'idle' ||
                  ![to, subject, instructions, body].some((value) => value.trim())
                }
                onClick={() => void generate()}
              >
                Generate draft
              </Button>
            )}
            <Button type="button" variant="ghost" size="sm" onClick={close}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
