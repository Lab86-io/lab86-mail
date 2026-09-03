import type { WorkHorizon } from '@/lib/albatross/horizon';
import { resolveShape } from '@/lib/albatross/shape-policy';
import type { WorkShape } from '@/lib/albatross/work-shape';

// The client side of Hold. The bar and "Hold this" on a chat reply both post
// to `/api/albatross/capture` with `source: 'chat'`, so the response carries
// the parsed Work (title, shape, horizon) for the landing card.

export const HOLD_ERROR = 'Could not hold that. Try again.';
export const HOLD_TEXT_MAX = 4_000;

export interface HoldCard {
  id: string;
  title: string;
  shape: WorkShape;
  horizon: WorkHorizon | null;
}

export interface HoldResult {
  cards: HoldCard[];
  /** True when the reply was already held and no new Work was written. */
  existing: boolean;
}

export interface HoldInput {
  /** The user's own words. */
  text: string;
  conversationId: string;
  /** The reply id, when the Hold came from a chat reply. Makes the Hold idempotent. */
  sourceMessageId?: string;
  /** The reply text, when the Hold came from a chat reply. */
  replyText?: string;
}

export interface HoldOptions {
  fetchImpl?: typeof fetch;
  timezone?: string;
}

/** The cards the landing shows, from a capture response body. */
export function holdCardsFromResponse(body: unknown): HoldCard[] {
  const rows = Array.isArray((body as any)?.work) ? ((body as any).work as any[]) : [];
  const cards = rows
    .filter((row) => row && typeof row === 'object')
    .map((row) => ({
      id: String(row.id || ''),
      title: String(row.title || '').trim() || 'Work',
      shape: resolveShape(typeof row.shape === 'string' ? row.shape : null),
      horizon: (row.horizon as WorkHorizon | null | undefined) ?? null,
    }))
    .filter((card) => card.id);
  if (cards.length) return cards;
  // A plain capture body answers with ids only. One card per id keeps the landing honest.
  const ids = Array.isArray((body as any)?.workIds) ? ((body as any).workIds as unknown[]) : [];
  return ids.filter(Boolean).map((id) => ({ id: String(id), title: 'Work', shape: 'quick', horizon: null }));
}

/** Post one Hold. Rejects with `HOLD_ERROR` on any failure, so the bar keeps the text. */
export async function holdText(input: HoldInput, options: HoldOptions = {}): Promise<HoldResult> {
  const text = input.text.trim().slice(0, HOLD_TEXT_MAX);
  if (!text) throw new Error(HOLD_ERROR);
  const fetchImpl = options.fetchImpl ?? fetch;
  let body: any;
  try {
    const response = await fetchImpl('/api/albatross/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        source: 'chat',
        conversationId: input.conversationId,
        sourceMessageId: input.sourceMessageId,
        replyText: input.replyText,
        timezone: options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    });
    body = await response.json().catch(() => null);
    if (!response.ok || !body?.ok) throw new Error(HOLD_ERROR);
  } catch {
    throw new Error(HOLD_ERROR);
  }
  const cards = holdCardsFromResponse(body);
  if (!cards.length) throw new Error(HOLD_ERROR);
  return { cards, existing: body.existing === true };
}

export interface HoldGeo {
  latitude: number;
  longitude: number;
}

/**
 * Best-effort location for the plan kick. Resolves null on denial, error, or
 * after `timeoutMs`. It never rejects.
 */
export function resolveGeo(timeoutMs = 2_500): Promise<HoldGeo | null> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (value: HoldGeo | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          clearTimeout(timer);
          finish({ latitude: position.coords.latitude, longitude: position.coords.longitude });
        },
        () => {
          clearTimeout(timer);
          finish(null);
        },
        { timeout: timeoutMs, maximumAge: 600_000 },
      );
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });
}

/**
 * Start the plan for each new Work. Best-effort: a failure here never reaches
 * the user, because the Work is already kept.
 */
export async function kickAdvance(
  workIds: string[],
  options: HoldOptions & { geo?: () => Promise<HoldGeo | null> } = {},
): Promise<void> {
  if (!workIds.length) return;
  const fetchImpl = options.fetchImpl ?? fetch;
  const geo = await (options.geo ?? resolveGeo)();
  const timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  for (const id of workIds) {
    try {
      void fetchImpl(`/api/albatross/work/${encodeURIComponent(id)}/advance`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ timezone, ...(geo ? { geo } : {}) }),
      }).catch(() => undefined);
    } catch {
      // The plan kick is an enhancement.
    }
  }
}
