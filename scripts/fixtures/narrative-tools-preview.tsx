/** Synthetic browser harness: no real accounts, provider calls, or sends. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NarrativeDraftAssistant } from '../../components/narrative/NarrativeDraftAssistant';
import { NarrativeMeetingPrep } from '../../components/narrative/NarrativeMeetingPrep';
import { emptyNarrativeContext } from '../../lib/narrative/context';

const context = {
  ...emptyNarrativeContext('meeting'),
  enabled: true,
  coverage: 'Synthetic history · Granola and Work · source-backed, partial coverage.',
  evidence: [
    {
      id: 'granola-example',
      title: 'Atlas launch planning · Granola',
      text: 'Alex and Sam agreed to hold the launch until QA passes. The review should settle the accessibility checks and the release owner.',
      source: 'mcp:granola',
      topics: [],
      trust: 'observed',
      occurredAt: Date.now(),
      observedAt: Date.now(),
    },
    {
      id: 'work-example',
      title: 'Atlas accessibility review',
      text: 'You reported completing keyboard navigation testing yesterday. Screen-reader verification remains open.',
      source: 'work',
      topics: [],
      trust: 'reported',
      occurredAt: Date.now(),
      observedAt: Date.now(),
    },
  ],
};
globalThis.fetch = (async (url, options) => {
  if (String(url).includes('/narrative/context')) return Response.json(context);
  if (String(url).includes('/narrative/meeting'))
    return Response.json({
      title: 'Atlas launch review',
      startAt: Date.now(),
      context,
      mode: 'generated',
      points: [
        {
          text: 'The launch is still conditional on QA. Yesterday you reported finishing keyboard testing; screen-reader verification remains open.',
          sourceIds: ['granola-example', 'work-example'],
        },
      ],
      questions: [
        'Who owns the remaining accessibility check?',
        'What would make the launch ready to approve?',
      ],
    });
  if (String(url).includes('/compose/draft')) {
    const input = JSON.parse(String(options?.body));
    return Response.json({
      draft: input.contextIds.length
        ? 'Hi Alex,\n\nAhead of our review, can we confirm who owns the remaining accessibility checks? We agreed to wait for QA before launching.\n\nThanks!'
        : 'Hi Alex,\n\nLooking forward to the launch review. What would you like us to cover?\n\nThanks!',
    });
  }
  throw new Error('The synthetic harness blocks all other requests.');
}) as typeof fetch;
function Preview() {
  const [body, setBody] = useState('Hi Alex,\n\nA quick follow-up before our launch review.');
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-8 text-[var(--color-text)]">
      <header>
        <p className="text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
          Synthetic interaction check · no real data
        </p>
        <h1 className="mt-2 font-display text-3xl">Context where you work</h1>
      </header>
      <div className="grid items-start gap-6 md:grid-cols-2">
        <section className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]">
          <div className="space-y-3 p-4">
            <h2 className="font-medium">Draft to Alex</h2>
            <p className="text-xs text-[var(--color-text-muted)]">Atlas launch review</p>
            <textarea
              aria-label="Email body"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              rows={5}
              className="w-full resize-none bg-transparent text-sm"
            />
          </div>
          <NarrativeDraftAssistant
            to="alex@example.test"
            subject="Atlas launch review"
            body={body}
            onApply={setBody}
          />
        </section>
        <section className="space-y-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
          <h2 className="font-display text-lg">Atlas launch review</h2>
          <p className="text-xs text-[var(--color-text-muted)]">Tomorrow · 10:00–10:30 · Alex and Sam</p>
          <NarrativeMeetingPrep accountId="synthetic" calendarId="synthetic" eventId="synthetic" />
        </section>
      </div>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Preview />);
