'use client';

import { notFound } from 'next/navigation';
import { useCallback, useRef, useState } from 'react';
import { AskHoldComposer, type DoorRequest } from '@/components/shell/AskHoldComposer';
import { HoldLanding } from '@/components/shell/HoldLanding';
import { HoldThisControl } from '@/components/shell/HoldThisControl';
import { QueryProvider } from '@/components/shell/QueryProvider';
import { RouteChip, RouteTabHint } from '@/components/shell/RouteChip';
import { useApplyThemeExtras } from '@/components/shell/ThemePanel';
import { HOLD_ERROR, type HoldCard, type HoldInput, type HoldResult } from '@/lib/albatross/capture-client';
import type { RouteVerdict } from '@/lib/albatross/route-classifier';
import { routeHeuristic } from '@/lib/albatross/route-classifier';

/* Dev-only harness: the Ask / Hold bar on fixtures, so the chip, the Tab
 * lock, the landing with one and three cards, "Hold this", and the error
 * line can be checked without a signed-in account. The route confirm and the
 * capture are fakes with a short delay. Not linked from anywhere; 404s
 * outside development. */
export default function BarPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <BarPreviewInner />;
}

const DAY = 24 * 60 * 60_000;

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** The fake endpoint: the heuristic after 400 ms, `ask` when unclear. */
async function fakePredict(text: string, { signal }: { signal: AbortSignal }): Promise<RouteVerdict> {
  await wait(400);
  if (signal.aborted) throw new DOMException('aborted', 'AbortError');
  return routeHeuristic(text) ?? { route: 'ask', confidence: 0.3, reason: 'model' };
}

function cardsFor(text: string, nowMs: number): HoldCard[] {
  const lower = text.toLowerCase();
  if (lower.includes('three') || lower.includes(',')) {
    return [
      { id: 'w1', title: 'Book the dentist', shape: 'quick', horizon: { kind: 'now', by: nowMs + 2 * DAY } },
      {
        id: 'w2',
        title: 'Renew the passport',
        shape: 'project',
        horizon: { kind: 'later', notBefore: nowMs + 59 * DAY },
      },
      { id: 'w3', title: 'Groceries for the week', shape: 'list', horizon: null },
    ];
  }
  return [
    {
      id: 'w1',
      title: text.replace(/^\w/, (c) => c.toUpperCase()).replace(/[.!]$/, ''),
      shape: lower.includes('every') ? 'recurring' : 'quick',
      horizon: lower.includes('before the trip') ? { kind: 'now', by: nowMs + 9 * DAY } : null,
    },
  ];
}

function BarPreviewInner() {
  useApplyThemeExtras();
  const [nowMs] = useState(() => Date.now());
  const [value, setValue] = useState('');
  const [door, setDoor] = useState<DoorRequest | null>(null);
  const [failNext, setFailNext] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const note = useCallback((line: string) => setLog((current) => [line, ...current].slice(0, 8)), []);
  const railRef = useRef<HTMLDivElement>(null);
  const [landingKey, setLandingKey] = useState(0);
  const [landingCards, setLandingCards] = useState<HoldCard[] | null>(null);
  const [replayCount, setReplayCount] = useState(1);

  const onHold = useCallback(
    async (text: string) => {
      await wait(900);
      if (failNext) {
        setFailNext(false);
        throw new Error(HOLD_ERROR);
      }
      const cards = cardsFor(text, nowMs);
      note(`held ${cards.length}: ${cards.map((card) => card.title).join(' / ')}`);
      return cards;
    },
    [failNext, nowMs, note],
  );

  const replay = (count: number) => {
    setReplayCount(count);
    setLandingCards(null);
    setLandingKey((key) => key + 1);
    setTimeout(
      () => setLandingCards(cardsFor(count === 3 ? 'three things' : 'renew the passport', nowMs)),
      700,
    );
  };

  const fakeHoldThis = async (input: HoldInput): Promise<HoldResult> => {
    await wait(600);
    note(`hold this ${input.sourceMessageId}`);
    return { cards: cardsFor('call the vet', nowMs), existing: false };
  };
  const failHoldThis = async (): Promise<HoldResult> => {
    await wait(300);
    throw new Error(HOLD_ERROR);
  };

  return (
    <QueryProvider clerkEnabled={false}>
      <div className="app-paper relative min-h-dvh">
        <div className="mx-auto flex max-w-4xl gap-6 px-5 py-10">
          <aside className="hidden w-44 shrink-0 sm:block">
            <p className="mb-2 text-[11px] text-[var(--color-text-faint)]">The rail</p>
            <div className="flex flex-col gap-1 text-[13px]">
              <div className="rounded-md px-2 py-1.5 text-[var(--color-text-muted)]">Today</div>
              <div
                ref={railRef}
                data-rail-target="albatrosses"
                className="rounded-md bg-[var(--color-accent-soft)] px-2 py-1.5 font-medium text-[var(--color-accent)]"
              >
                Albatrosses
              </div>
              <div className="rounded-md px-2 py-1.5 text-[var(--color-text-muted)]">Mail</div>
            </div>
          </aside>

          <div className="min-w-0 flex-1">
            <section className="mb-8">
              <h2 className="mb-1 font-serif text-[15px] font-semibold">The bar</h2>
              <p className="mb-3 text-[12px] text-[var(--color-text-muted)]">
                Type a question for Ask. Type an errand for Hold. Tab flips the chip. Enter follows it.
                Cmd+Enter sends to chat.
              </p>
              <div className="rounded-3xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]/85 pt-2 shadow-[var(--shadow-soft)]">
                <AskHoldComposer
                  value={value}
                  onValueChange={setValue}
                  canSend={Boolean(value.trim())}
                  onSend={() => {
                    note(`send to chat: ${value.trim()}`);
                    setValue('');
                  }}
                  onHold={onHold}
                  onHeld={(cards) => note(`landed ${cards.length}`)}
                  door={door}
                  predict={fakePredict}
                  railTarget={() => railRef.current}
                  now={() => nowMs}
                />
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-[12px]">
                <button
                  type="button"
                  className="rounded-full border border-[var(--color-border)] px-3 py-1"
                  onClick={() => setDoor({ seed: null, nonce: (door?.nonce ?? 0) + 1 })}
                >
                  Get this off my mind
                </button>
                <button
                  type="button"
                  className="rounded-full border border-[var(--color-border)] px-3 py-1"
                  onClick={() =>
                    setDoor({ seed: 'Reply to Sarah about the venue', nonce: (door?.nonce ?? 0) + 1 })
                  }
                >
                  Open with a selection
                </button>
                <button
                  type="button"
                  className="rounded-full border border-[var(--color-border)] px-3 py-1"
                  onClick={() => setValue('what did Sarah say about the venue?')}
                >
                  Fill an Ask
                </button>
                <button
                  type="button"
                  className="rounded-full border border-[var(--color-border)] px-3 py-1"
                  onClick={() => setValue('book the dentist before the trip')}
                >
                  Fill a Hold
                </button>
                <button
                  type="button"
                  className="rounded-full border border-[var(--color-border)] px-3 py-1"
                  onClick={() => setValue('three things: dentist, passport, groceries')}
                >
                  Fill a split
                </button>
                <button
                  type="button"
                  aria-pressed={failNext}
                  className="rounded-full border border-[var(--color-border)] px-3 py-1 aria-pressed:border-[var(--color-danger)] aria-pressed:text-[var(--color-danger)]"
                  onClick={() => setFailNext((current) => !current)}
                >
                  Fail the next Hold
                </button>
              </div>
            </section>

            <section className="mb-8">
              <h2 className="mb-1 font-serif text-[15px] font-semibold">The chip</h2>
              <div className="flex flex-wrap items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-4">
                <RouteChip route="ask" disabled />
                <RouteChip route="ask" />
                <RouteChip route="ask" pending />
                <RouteChip route="ask" locked />
                <RouteChip route="hold" />
                <RouteChip route="hold" pending />
                <RouteChip route="hold" locked />
                <span className="inline-flex items-center gap-2">
                  <RouteTabHint visible />
                  <RouteChip route="hold" />
                </span>
              </div>
            </section>

            <section className="mb-8">
              <div className="mb-1 flex items-baseline gap-3">
                <h2 className="font-serif text-[15px] font-semibold">The landing</h2>
                <button type="button" className="text-[12px] underline" onClick={() => replay(1)}>
                  Replay one
                </button>
                <button type="button" className="text-[12px] underline" onClick={() => replay(3)}>
                  Replay three
                </button>
              </div>
              <div className="rounded-2xl border border-[var(--color-accent-2)]/35 bg-[var(--color-control)]/95 p-2 shadow-[var(--shadow-pop)]">
                <div className="flex items-start gap-2 px-1 pt-1">
                  <RouteChip route="hold" locked className="mt-1.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <HoldLanding
                      key={landingKey}
                      text={
                        replayCount === 3
                          ? 'three things: dentist, passport, groceries'
                          : 'renew the passport'
                      }
                      cards={landingCards}
                      nowMs={nowMs}
                      railTarget={() => railRef.current}
                      onDone={() => note(`landing done (${replayCount})`)}
                    />
                  </div>
                </div>
              </div>
            </section>

            <section className="mb-8">
              <h2 className="mb-1 font-serif text-[15px] font-semibold">Hold this on a reply</h2>
              <div className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-4 text-[13px]">
                <p>Three steps: call the vet, book the slot, and set a reminder for the shots.</p>
                <HoldThisControl
                  messageId="m1"
                  conversationId="c1"
                  userText="what should I do about the dog"
                  replyText="Three steps: call the vet, book the slot, and set a reminder."
                  hold={fakeHoldThis}
                  onKept={() => note('kept m1')}
                />
                <p className="text-[var(--color-text-muted)]">A reply whose Hold fails:</p>
                <HoldThisControl
                  messageId="m2"
                  conversationId="c1"
                  userText="and the cat"
                  replyText="One step."
                  hold={failHoldThis}
                />
              </div>
            </section>

            <pre className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-3 text-[11px] text-[var(--color-text-muted)]">
              {log.join('\n') || 'No events yet.'}
            </pre>
          </div>
        </div>
      </div>
    </QueryProvider>
  );
}
