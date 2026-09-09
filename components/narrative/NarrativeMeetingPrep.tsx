'use client';

import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import type { MeetingSelector } from '@/lib/narrative/meeting-prep';

const meetingView = z.object({
  context: z.object({
    coverage: z.string(),
    evidence: z.array(z.object({ id: z.string(), title: z.string() })),
  }),
  points: z.array(z.object({ text: z.string(), sourceIds: z.array(z.string()) })),
  questions: z.array(z.string()),
  mode: z.enum(['generated', 'evidence', 'empty']),
});

export function NarrativeMeetingPrep(props: MeetingSelector) {
  return <MeetingPanel key={JSON.stringify(props)} {...props} />;
}
function MeetingPanel(selector: MeetingSelector) {
  const [result, setResult] = useState<z.infer<typeof meetingView> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  async function prepare() {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const response = await fetch('/api/narrative/meeting', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(selector),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data) throw new Error(data?.error || 'Meeting prep is unavailable.');
      const parsed = meetingView.safeParse(data);
      if (!parsed.success) throw new Error('Meeting prep is unavailable. Please try again.');
      if (!controller.signal.aborted) setResult(parsed.data);
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(failure instanceof Error ? failure.message : 'Meeting prep is unavailable.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  return (
    <section
      aria-label="Meeting preparation"
      className="space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-3 text-xs"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium">Before you meet</h3>
        <Button type="button" size="sm" variant="ghost" disabled={loading} onClick={() => void prepare()}>
          {result ? 'Refresh prep' : 'Prepare meeting'}
        </Button>
      </div>
      {!result && !loading && !error && (
        <p className="text-[var(--color-text-muted)]">
          Relevant decisions and open loops from Granola and your other opted-in sources.
        </p>
      )}
      {loading && (
        <div className="flex items-center gap-2">
          <p role="status">Preparing from your history…</p>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              pending.current?.abort();
              setLoading(false);
            }}
          >
            Cancel
          </Button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {result && (
        <>
          <p className="text-[11px] text-[var(--color-text-muted)]">{result.context.coverage}</p>
          {result.mode === 'evidence' && (
            <p className="text-[var(--color-text-muted)]">
              Showing source excerpts; generated prep was unavailable.
            </p>
          )}
          {result.mode === 'empty' && (
            <p>
              No related history available.{' '}
              <a href="/narrative" className="underline">
                Review memory sources
              </a>
              .
            </p>
          )}
          <ul className="space-y-2">
            {result.points.map((point) => (
              <li key={`${point.sourceIds.join(':')}:${point.text}`}>
                <p className="leading-relaxed">{point.text}</p>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                  {point.sourceIds.map((id) => (
                    <a
                      key={id}
                      href={`/narrative?id=${encodeURIComponent(id)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[var(--color-accent)] underline"
                    >
                      {result.context.evidence.find((item) => item.id === id)?.title || 'Source'}
                    </a>
                  ))}
                </div>
              </li>
            ))}
          </ul>
          {result.questions.length > 0 && (
            <div>
              <h4 className="mb-1 font-medium">Questions to consider</h4>
              <ul className="list-disc space-y-1 pl-4">
                {[...new Set(result.questions)].map((question) => (
                  <li key={question}>{question}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
