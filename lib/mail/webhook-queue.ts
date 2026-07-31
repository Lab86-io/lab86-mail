import { ingestNylasWebhookPayload } from './corpus-sync';

// Nylas drops the connection at ~20s and marks the subscription failing after
// 15 minutes of timeouts, so deliveries must be ACKed immediately and ingested
// out-of-band. Processing is at-least-once by design: events are deduped by
// eventId in recordWebhookEvent, and the reconciler repairs anything lost to a
// process restart — exactly the same guarantee the synchronous path had for
// events that died mid-request.
const CONCURRENCY = 4;
const MAX_QUEUE = 5_000;

const queue: unknown[] = [];
let active = 0;
let dropped = 0;
// A redelivered backlog can fail in bursts (Nylas 5xx on stale/deleted
// resources); logging every one floods Railway. Sample the failures instead.
let ingestFailures = 0;
// Failure reason -> count, so each distinct fault is reported at least once.
// Reasons often carry an id, so the set of distinct strings is unbounded in a
// process that runs for weeks. Keep the map bounded and start again when it
// fills: reporting a reason a second time costs one log line, and holding
// every reason forever costs memory that is never returned.
const MAX_FAILURE_REASONS = 500;
const failureReasons = new Map<string, number>();

// Returns false when the buffer is full so the caller can reject the delivery
// with a non-2xx — that tells Nylas to retry it later instead of the event
// being silently dropped (and the reconciler doesn't cover deletes).
export function enqueueNylasWebhook(payload: unknown): boolean {
  if (queue.length >= MAX_QUEUE) {
    dropped += 1;
    if (dropped % 100 === 1) {
      console.error(`[nylas-webhook] queue full (${MAX_QUEUE}); rejected ${dropped} events for retry`);
    }
    return false;
  }
  queue.push(payload);
  pump();
  return true;
}

export function webhookQueueDepth() {
  return { queued: queue.length, active };
}

// The sampling counters are process-global on purpose, which makes them shared
// state between tests. Clearing them keeps each test's assertion about "the
// first occurrence" true rather than dependent on what ran before it.
export function __resetWebhookSamplingForTest() {
  failureReasons.clear();
  ingestFailures = 0;
  dropped = 0;
}

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const payload = queue.shift();
    active += 1;
    void ingestNylasWebhookPayload(payload)
      .catch((err: any) => {
        ingestFailures += 1;
        // Sample by *distinct reason*, not by raw count. Counting hid a real
        // outage: one fault repeating on every delivery for weeks printed
        // roughly one line, because only the 1st and every 50th were kept.
        // Per-reason sampling still bounds a burst, but a new failure mode is
        // always reported at least once.
        const reason = String(err?.message || err).slice(0, 200);
        if (!failureReasons.has(reason) && failureReasons.size >= MAX_FAILURE_REASONS) {
          failureReasons.clear();
        }
        const seen = (failureReasons.get(reason) ?? 0) + 1;
        failureReasons.set(reason, seen);
        if (seen === 1 || seen % 50 === 0) {
          console.error(
            `[nylas-webhook] ingest failed (${seen}x this reason, ${ingestFailures} total): ${reason}`,
          );
        }
      })
      .finally(() => {
        active -= 1;
        pump();
      });
  }
}
