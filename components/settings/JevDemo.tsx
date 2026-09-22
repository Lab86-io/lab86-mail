'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { JEV_DEMO_EXAMPLES, type JevDemoResult } from '@/lib/jev/demo';

export function JevDemo({ configured }: { configured: boolean }) {
  const [example, setExample] = useState('promotion');
  const [input, setInput] = useState(JEV_DEMO_EXAMPLES[0].input);
  const [result, setResult] = useState<JevDemoResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fieldClass =
    'w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm';
  return (
    <section
      aria-labelledby="jev-demo-heading"
      className="space-y-3 border-t border-[var(--color-border)] pt-6"
    >
      <h3 id="jev-demo-heading" className="text-sm font-medium">
        Try Jev live
      </h3>
      <p className="text-xs leading-relaxed text-[var(--color-text-muted)]">
        Try an example or edit the text. Jev will classify it now using the same questions as incoming mail.
        This demo does not change your mailbox.
      </p>
      <form
        className="space-y-3"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          setResult(null);
          try {
            const response = await fetch('/api/jev/demo', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(input),
            });
            const value = await response.json();
            if (!response.ok) throw new Error(value.error || 'The demo could not run. Try again.');
            setResult(value);
          } catch (error) {
            setError(error instanceof Error ? error.message : 'The demo could not run. Try again.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="space-y-1 text-xs">
          <label htmlFor="jev-demo-example">Example</label>
          <select
            id="jev-demo-example"
            className={fieldClass}
            value={example}
            disabled={busy}
            onChange={(event) => {
              const selected = JEV_DEMO_EXAMPLES.find((item) => item.id === event.target.value)!;
              setExample(selected.id);
              setInput(selected.input);
              setResult(null);
              setError('');
            }}
          >
            {JEV_DEMO_EXAMPLES.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1 text-xs" htmlFor="jev-demo-sender">
            <span>Sender</span>
            <Input
              id="jev-demo-sender"
              type="email"
              required
              maxLength={254}
              disabled={busy}
              value={input.sender}
              onChange={(event) => {
                setInput({ ...input, sender: event.target.value });
                setResult(null);
              }}
            />
          </label>
          <label className="block space-y-1 text-xs" htmlFor="jev-demo-subject">
            <span>Subject</span>
            <Input
              id="jev-demo-subject"
              required
              maxLength={300}
              disabled={busy}
              value={input.subject}
              onChange={(event) => {
                setInput({ ...input, subject: event.target.value });
                setResult(null);
              }}
            />
          </label>
        </div>
        <label className="block space-y-1 text-xs" htmlFor="jev-demo-body">
          <span>Message</span>
          <textarea
            id="jev-demo-body"
            className={fieldClass}
            rows={4}
            required
            maxLength={2400}
            disabled={busy}
            value={input.body}
            onChange={(event) => {
              setInput({ ...input, body: event.target.value });
              setResult(null);
            }}
          />
        </label>
        <label className="block space-y-1 text-xs" htmlFor="jev-demo-reply">
          <span>Your reply (optional)</span>
          <textarea
            id="jev-demo-reply"
            className={fieldClass}
            rows={2}
            maxLength={2400}
            disabled={busy}
            value={input.reply}
            onChange={(event) => {
              setInput({ ...input, reply: event.target.value });
              setResult(null);
            }}
          />
        </label>
        <Button size="sm" type="submit" disabled={busy || !configured}>
          {busy ? 'Classifying…' : 'Classify live'}
        </Button>
        <p className="text-xs text-[var(--color-text-muted)]">
          Uses your Brief preferences. Sender and thread corrections apply to real mail, not these examples.
        </p>
      </form>
      {error ? (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}
      <div aria-live="polite" aria-atomic="true">
        {result ? (
          <div
            className="space-y-3 rounded-[var(--radius-control)] border border-[var(--color-border)] p-4"
            data-jev-demo-result
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm font-medium">
                {result.category} ·{' '}
                {result.briefEligible ? 'Eligible for the Brief' : 'Kept out of the Brief'}
              </p>
              <span className="text-xs tabular-nums text-[var(--color-text-muted)]">
                Jev call: {result.inferenceMs} ms
              </span>
            </div>
            <p className="text-sm">{result.reason}</p>
            <p className="text-xs text-[var(--color-text-muted)]">
              {result.status === 'uncertain' ? 'Needs more context. ' : ''}
              {result.obligations.length
                ? `Open: ${result.obligations.join(', ')}.`
                : 'No open reply or action.'}
              {result.meaningfulChange ? ' A meaningful change was reported.' : ''}
            </p>
            {result.evidence.map((text) => (
              <blockquote
                key={text}
                className="whitespace-pre-wrap break-words border-l-2 border-[var(--color-border)] pl-3 text-xs text-[var(--color-text-muted)]"
              >
                {text}
              </blockquote>
            ))}
            <p className="text-xs text-[var(--color-text-muted)]">
              On incoming mail, these results are saved and reused by Mail and the Brief. The time above
              measures the model request, not mail delivery.
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
