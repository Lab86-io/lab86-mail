import { z } from 'zod';
import { generateTextForCurrentUser } from '@/lib/ai/gateway';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';

// Background area classification: file recent unclaimed mail threads, calendar
// events, and freshly captured intents into the user's areas. Two phases,
// cheapest first:
//   1. Deterministic — a sender/organizer/attendee address or domain exactly
//      matches an area fact. A verified fact yields a VERIFIED link (trust
//      inherited from the user's own confirmation of that fact); a candidate
//      fact yields a candidate link.
//   2. One fast-model verdict for whatever remains (capped per call). The model
//      can only ever produce CANDIDATE links — verification stays human.
// Anything the model looked at but could not confidently place falls back to
// the Personal catch-all area, so every new artifact ends up filed somewhere.
// Threads the model never answered for (or a failed call) stay unlinked and
// retry on the next cron tick.
// Dependency seam mirrors lib/albatross/intent-plan.ts so tests swap the
// network edges and exercise the real orchestration.

const defaultDeps = {
  api: api as any,
  convexQuery,
  convexMutation,
  generateTextForCurrentUser,
};

let deps = defaultDeps;

export function __setAreaClassifierDepsForTest(overrides: Partial<typeof defaultDeps> = {}) {
  deps = { ...defaultDeps, ...overrides };
}

export const LLM_BATCH_CAP = 20;
export const FETCH_LIMIT = 50;
// Per cron run the queue loop re-fetches at most this many times, so one run
// clears up to MAX_ROUNDS × LLM_BATCH_CAP model verdicts of backlog while the
// steady state (new items only) stays a single round.
export const MAX_ROUNDS = 3;

export interface ClassifiableThread {
  providerThreadId: string;
  accountId: string;
  subject: string;
  fromAddress: string;
  lastDate: number;
  snippet?: string;
}

export interface ClassifiableEvent {
  eventId: string;
  accountId: string;
  title: string;
  organizerEmail: string | null;
  participantEmails: string[];
  startAt: number;
  location: string | null;
}

export interface ClassifiableIntent {
  intentId: string;
  title: string | null;
  rawText: string;
  source: string;
}

export interface AreaFactLite {
  _id: string;
  areaId: string;
  kind: string;
  value: string;
  status: 'candidate' | 'verified' | 'rejected' | 'superseded';
  verifiedAt?: number;
  updatedAt?: number;
}

export interface FactMatch {
  areaId: string;
  status: 'candidate' | 'verified';
  matchType: 'email' | 'domain';
  matchValue: string;
  reason: string;
  fact: AreaFactLite;
}

/** Pull the bare address out of a From header ("Name <a@b.com>" → a@b.com). */
export function extractEmail(raw: string): string | null {
  const angled = raw.match(/<([^>]+)>/);
  const candidate = (angled ? angled[1] : raw).trim().toLowerCase();
  const token = candidate.split(/\s+/).find((part) => part.includes('@'));
  const email = (token || '').replace(/^mailto:/, '').replace(/[<>,;"']/g, '');
  return email.includes('@') ? email : null;
}

/** Normalize a fact value for identity matching: lowercase, no mailto:, no leading @. */
function normalizedFactValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^mailto:/, '')
    .replace(/^@/, '');
}

/** A fact value is matchable when it is an address or looks like a bare domain. */
function factValueKind(value: string): 'email' | 'domain' | null {
  if (!value || /\s/.test(value)) return null;
  if (value.includes('@')) return 'email';
  if (value.includes('.')) return 'domain';
  return null;
}

const rankMatch = (match: FactMatch) =>
  (match.status === 'verified' ? 2 : 0) + (match.matchType === 'email' ? 1 : 0);

/**
 * Phase-1 deterministic match: the thread sender's exact address or exact
 * domain against email/domain-shaped facts. Verified facts outrank candidate
 * facts; an email match outranks a domain match at the same trust level.
 */
export function matchThreadToFacts(
  thread: Pick<ClassifiableThread, 'fromAddress'>,
  facts: AreaFactLite[],
): FactMatch | null {
  const email = extractEmail(thread.fromAddress || '');
  if (!email) return null;
  const domain = email.split('@')[1] || '';
  let best: FactMatch | null = null;
  for (const fact of facts) {
    if (fact.status !== 'verified' && fact.status !== 'candidate') continue;
    const value = normalizedFactValue(fact.value);
    const kind = factValueKind(value);
    if (!kind) continue;
    const matches = kind === 'email' ? email === value : domain === value;
    if (!matches) continue;
    const match: FactMatch = {
      areaId: fact.areaId,
      status: fact.status,
      matchType: kind,
      matchValue: value,
      reason: `${fact.status} ${kind} ${value}`,
      fact,
    };
    if (!best || rankMatch(match) > rankMatch(best)) best = match;
  }
  return best;
}

/**
 * Deterministic match for a calendar event: the organizer's address or domain
 * behaves like a mail sender; attendee addresses only ever match exact email
 * facts (a shared free-mail domain across attendees would misfire badly).
 */
export function matchEventToFacts(
  event: Pick<ClassifiableEvent, 'organizerEmail' | 'participantEmails'>,
  facts: AreaFactLite[],
): FactMatch | null {
  if (event.organizerEmail) {
    const organizerMatch = matchThreadToFacts({ fromAddress: event.organizerEmail }, facts);
    if (organizerMatch) {
      return { ...organizerMatch, reason: `organizer ${organizerMatch.reason}` };
    }
  }
  let best: FactMatch | null = null;
  for (const email of event.participantEmails || []) {
    for (const fact of facts) {
      if (fact.status !== 'verified' && fact.status !== 'candidate') continue;
      const value = normalizedFactValue(fact.value);
      if (factValueKind(value) !== 'email' || value !== email) continue;
      const match: FactMatch = {
        areaId: fact.areaId,
        status: fact.status,
        matchType: 'email',
        matchValue: value,
        reason: `${fact.status} attendee ${value}`,
        fact,
      };
      if (!best || rankMatch(match) > rankMatch(best)) best = match;
    }
  }
  return best;
}

const confidenceSchema = z.enum(['high', 'medium', 'low']).catch('low');

const genericVerdictSchema = z.object({
  id: z.string().min(1),
  areaName: z.string().nullish(),
  confidence: confidenceSchema,
});

export interface ClassifierVerdict {
  threadId: string;
  areaName?: string | null;
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Parse the model's JSON verdict list defensively: strip fences, find the
 * array, drop malformed entries individually. Any unrecoverable output means
 * an empty verdict list — never a throw. `idKey` names the identifier field
 * the prompt asked for (threadId / eventId / intentId).
 */
export function parseIdVerdicts(
  raw: string,
  idKey: string,
): Array<{ id: string; areaName?: string | null; confidence: 'high' | 'medium' | 'low' }> {
  try {
    let text = (raw || '').trim();
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) text = fence[1].trim();
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end <= start) return [];
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    const verdicts: Array<{ id: string; areaName?: string | null; confidence: 'high' | 'medium' | 'low' }> =
      [];
    for (const entry of parsed) {
      const result = genericVerdictSchema.safeParse({
        id: entry?.[idKey],
        areaName: entry?.areaName,
        confidence: entry?.confidence,
      });
      if (result.success) verdicts.push(result.data);
    }
    return verdicts;
  } catch {
    return [];
  }
}

/** Back-compat wrapper for the mail prompt's threadId-keyed verdicts. */
export function parseClassifierOutput(raw: string): ClassifierVerdict[] {
  return parseIdVerdicts(raw, 'threadId').map((verdict) => ({
    threadId: verdict.id,
    areaName: verdict.areaName,
    confidence: verdict.confidence,
  }));
}

function classifySystemPrompt(noun: string, idKey: string): string {
  return `You assign ${noun} to the user's life areas. You get the areas with their known facts, then a list of ${noun} to file.

Rules:
- Only assign an item when it clearly belongs to one area's facts or obvious scope. When unsure, use null.
- confidence "high" means you would defend the assignment from the listed facts alone. Anything weaker is "medium" or "low".
- Respond with ONE JSON array, no prose: [{"${idKey}": string, "areaName": string|null, "confidence": "high"|"medium"|"low"}]. Include every item exactly once. areaName must be copied exactly from the provided area names.`;
}

function areasBlock(areas: any[], factsByArea: Map<string, AreaFactLite[]>): string {
  return areas
    .map((area) => {
      const facts = (factsByArea.get(String(area._id)) || [])
        .slice(0, 12)
        .map((fact) => `  - [${fact.status}] ${fact.kind}: ${fact.value}`);
      return [
        `- ${area.name} (${area.kind})${area.description ? ` — ${area.description}` : ''}`,
        ...facts,
      ].join('\n');
    })
    .join('\n');
}

function threadsBlock(threads: ClassifiableThread[]): string {
  return threads
    .map(
      (thread) =>
        `- threadId=${thread.providerThreadId} | from=${extractEmail(thread.fromAddress) || thread.fromAddress} | subject=${(thread.subject || '(no subject)').slice(0, 120)}`,
    )
    .join('\n');
}

function eventsBlock(events: ClassifiableEvent[]): string {
  return events
    .map((event) => {
      const attendees = event.participantEmails.slice(0, 6).join(', ');
      return `- eventId=${event.eventId} | title=${(event.title || '(untitled)').slice(0, 120)} | organizer=${event.organizerEmail || 'unknown'} | attendees=${attendees || 'none'} | starts=${new Date(event.startAt).toISOString()}${event.location ? ` | location=${event.location.slice(0, 80)}` : ''}`;
    })
    .join('\n');
}

function intentsBlock(intents: ClassifiableIntent[]): string {
  return intents
    .map(
      (intent) =>
        `- intentId=${intent.intentId} | title=${(intent.title || '(untitled)').slice(0, 120)} | text=${intent.rawText.replace(/\s+/g, ' ').slice(0, 240)}`,
    )
    .join('\n');
}

interface LinkWrite {
  areaId: string;
  artifactKind?: 'mailThread' | 'calendarEvent';
  artifactId: string;
  accountId?: string;
  role?: 'secondary' | 'supporting';
  status: 'candidate' | 'verified';
  confidence?: number;
  reason?: string;
  sourceRefs?: Array<Record<string, unknown>>;
  confirmationRefs?: Array<Record<string, unknown>>;
}

function deterministicLink(
  artifact: { kind: 'mailThread' | 'calendarEvent'; artifactId: string; accountId?: string },
  match: FactMatch,
): LinkWrite {
  const base: LinkWrite = {
    areaId: match.areaId,
    artifactKind: artifact.kind,
    artifactId: artifact.artifactId,
    accountId: artifact.accountId,
    status: match.status,
    confidence: match.status === 'verified' ? 0.95 : 0.7,
    reason: match.reason,
    sourceRefs: [
      {
        kind: 'areaFact',
        id: String(match.fact._id),
        label: `${match.fact.kind}: ${match.fact.value}`.slice(0, 200),
      },
    ],
  };
  if (match.status === 'verified') {
    // The link inherits the user's confirmation of the underlying fact — the
    // server rejects verified links without a userConfirmation ref.
    base.confirmationRefs = [
      {
        kind: 'userConfirmation',
        id: `areaFact:${match.fact._id}`,
        confirmedAt: match.fact.verifiedAt ?? match.fact.updatedAt ?? Date.now(),
        prompt: 'Inherited from a user-verified area fact',
        sourceRefId: String(match.fact._id),
      },
    ];
  }
  return base;
}

function personalFallbackLink(
  personalAreaId: string,
  artifact: { kind: 'mailThread' | 'calendarEvent'; artifactId: string; accountId?: string },
): LinkWrite {
  return {
    areaId: personalAreaId,
    artifactKind: artifact.kind,
    artifactId: artifact.artifactId,
    accountId: artifact.accountId,
    // Mirrors the reindex backfill: catch-all placements are secondary,
    // low-confidence candidates so real matches always outrank them.
    role: 'secondary',
    status: 'candidate',
    confidence: 0.25,
    reason: 'No confident area match — filed to Personal',
    sourceRefs: [{ kind: 'system', id: 'area-classifier', label: 'Personal fallback' }],
  };
}

export interface ClassifyResult {
  deterministic: number;
  llm: number;
  personal: number;
  skipped: number;
}

interface AreaContext {
  personalAreaId: string;
  areas: any[];
  nonPersonalAreas: any[];
  areaByName: Map<string, any>;
  facts: AreaFactLite[];
  factsByArea: Map<string, AreaFactLite[]>;
}

async function loadAreaContext(userId: string): Promise<AreaContext> {
  const albatross = (deps.api as any).albatross;
  const [{ areaId: personalAreaId }, areas, verifiedFacts, candidateFacts] = await Promise.all([
    deps.convexMutation<{ areaId: string }>(albatross.ensurePersonal, { userId }),
    deps.convexQuery<any[]>(albatross.listAreas, { userId, status: 'active' }),
    deps.convexQuery<AreaFactLite[]>(albatross.listUserAreaFacts, { userId, status: 'verified' }),
    deps.convexQuery<AreaFactLite[]>(albatross.listUserAreaFacts, { userId, status: 'candidate' }),
  ]);
  const activeAreaIds = new Set(areas.map((area) => String(area._id)));
  const facts = [...verifiedFacts, ...candidateFacts].filter((fact) =>
    activeAreaIds.has(String(fact.areaId)),
  );
  const factsByArea = new Map<string, AreaFactLite[]>();
  for (const fact of facts) {
    const key = String(fact.areaId);
    factsByArea.set(key, [...(factsByArea.get(key) || []), fact]);
  }
  return {
    personalAreaId: String(personalAreaId),
    areas,
    nonPersonalAreas: areas.filter((area) => String(area._id) !== String(personalAreaId)),
    areaByName: new Map(areas.map((area) => [String(area.name).toLowerCase(), area])),
    facts,
    factsByArea,
  };
}

/**
 * One fast-model verdict pass over a batch of items. Returns per-item ids
 * split by outcome; a failed or partial model call leaves items unanswered so
 * the caller can retry them on a later tick.
 */
async function llmVerdictPass(input: {
  userId: string;
  context: AreaContext;
  idKey: string;
  noun: string;
  itemsBlock: string;
  ids: Set<string>;
}): Promise<{ assigned: Map<string, any>; unassigned: Set<string>; failed: boolean }> {
  const assigned = new Map<string, any>();
  const unassigned = new Set<string>();
  try {
    const { text } = await deps.generateTextForCurrentUser({
      feature: 'albatross_classify',
      speed: 'fast',
      userId: input.userId,
      system: classifySystemPrompt(input.noun, input.idKey),
      prompt: `## Areas\n${areasBlock(input.context.areas, input.context.factsByArea)}\n\n## Items\n${input.itemsBlock}`,
    });
    for (const verdict of parseIdVerdicts(text, input.idKey)) {
      if (!input.ids.has(verdict.id) || assigned.has(verdict.id) || unassigned.has(verdict.id)) continue;
      const area = verdict.areaName
        ? input.context.areaByName.get(verdict.areaName.toLowerCase())
        : undefined;
      if (area && verdict.confidence === 'high') assigned.set(verdict.id, area);
      else unassigned.add(verdict.id);
    }
    return { assigned, unassigned, failed: false };
  } catch (err) {
    console.warn(`[area-classifier] llm phase (${input.noun}) failed:`, err);
    return { assigned, unassigned, failed: true };
  }
}

export async function classifyThreads({ userId }: { userId: string }): Promise<ClassifyResult> {
  const albatross = (deps.api as any).albatross;
  const context = await loadAreaContext(userId);
  const totals: ClassifyResult = { deterministic: 0, llm: 0, personal: 0, skipped: 0 };
  // Ids already handled this run: linked, or answered/failed and deferred to
  // the next tick. Overflow past the per-call LLM cap stays out of this set so
  // the next round picks it up.
  const settled = new Set<string>();

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const fetched = await deps.convexQuery<ClassifiableThread[]>(albatross.unclassifiedThreads, {
      userId,
      limit: FETCH_LIMIT,
    });
    const threads = fetched.filter((thread) => !settled.has(thread.providerThreadId));
    if (!threads.length) break;

    const links: LinkWrite[] = [];
    const remaining: ClassifiableThread[] = [];
    for (const thread of threads) {
      const match = matchThreadToFacts(thread, context.facts);
      if (match) {
        links.push(
          deterministicLink(
            { kind: 'mailThread', artifactId: thread.providerThreadId, accountId: thread.accountId },
            match,
          ),
        );
        settled.add(thread.providerThreadId);
        totals.deterministic += 1;
      } else {
        remaining.push(thread);
      }
    }

    if (remaining.length && !context.nonPersonalAreas.length) {
      // Personal is the only area there is — no model call can say otherwise.
      for (const thread of remaining) {
        links.push(
          personalFallbackLink(context.personalAreaId, {
            kind: 'mailThread',
            artifactId: thread.providerThreadId,
            accountId: thread.accountId,
          }),
        );
        settled.add(thread.providerThreadId);
        totals.personal += 1;
      }
    } else if (remaining.length) {
      const batch = remaining.slice(0, LLM_BATCH_CAP);
      const byId = new Map(batch.map((thread) => [thread.providerThreadId, thread]));
      const pass = await llmVerdictPass({
        userId,
        context,
        idKey: 'threadId',
        noun: 'mail threads',
        itemsBlock: threadsBlock(batch),
        ids: new Set(byId.keys()),
      });
      for (const [id, area] of pass.assigned) {
        const thread = byId.get(id)!;
        // LLM verdicts are NEVER verified — candidate only, human confirms.
        links.push({
          areaId: String(area._id),
          artifactKind: 'mailThread',
          artifactId: thread.providerThreadId,
          accountId: thread.accountId,
          status: 'candidate',
          confidence: 0.6,
          reason: `llm high-confidence match to ${area.name}`,
        });
        settled.add(id);
        totals.llm += 1;
      }
      for (const id of pass.unassigned) {
        const thread = byId.get(id)!;
        // The model looked and could not place it — catch-all, not limbo.
        links.push(
          personalFallbackLink(context.personalAreaId, {
            kind: 'mailThread',
            artifactId: thread.providerThreadId,
            accountId: thread.accountId,
          }),
        );
        settled.add(id);
        totals.personal += 1;
      }
      // Threads the model never answered for (or the whole call failing) are
      // settled without a link: they retry on the next cron tick, not now.
      for (const thread of batch) {
        if (settled.has(thread.providerThreadId)) continue;
        settled.add(thread.providerThreadId);
        totals.skipped += 1;
      }
    }

    if (links.length) {
      await deps.convexMutation(albatross.recordAreaLinks, { userId, links });
    }
    // A short fetch with everything settled means the queue is drained; a
    // thread left unsettled is LLM-cap overflow the next round picks up.
    if (fetched.length < FETCH_LIMIT && threads.every((thread) => settled.has(thread.providerThreadId))) {
      break;
    }
    if (!links.length) break;
  }
  return totals;
}

export async function classifyCalendarEvents({ userId }: { userId: string }): Promise<ClassifyResult> {
  const albatross = (deps.api as any).albatross;
  const context = await loadAreaContext(userId);
  const totals: ClassifyResult = { deterministic: 0, llm: 0, personal: 0, skipped: 0 };
  const settled = new Set<string>();

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const fetched = await deps.convexQuery<ClassifiableEvent[]>(albatross.unclassifiedCalendarEvents, {
      userId,
      limit: FETCH_LIMIT,
    });
    const events = fetched.filter((event) => !settled.has(event.eventId));
    if (!events.length) break;

    const links: LinkWrite[] = [];
    const remaining: ClassifiableEvent[] = [];
    for (const event of events) {
      const match = matchEventToFacts(event, context.facts);
      if (match) {
        links.push(
          deterministicLink(
            { kind: 'calendarEvent', artifactId: event.eventId, accountId: event.accountId },
            match,
          ),
        );
        settled.add(event.eventId);
        totals.deterministic += 1;
      } else {
        remaining.push(event);
      }
    }

    if (remaining.length && !context.nonPersonalAreas.length) {
      for (const event of remaining) {
        links.push(
          personalFallbackLink(context.personalAreaId, {
            kind: 'calendarEvent',
            artifactId: event.eventId,
            accountId: event.accountId,
          }),
        );
        settled.add(event.eventId);
        totals.personal += 1;
      }
    } else if (remaining.length) {
      const batch = remaining.slice(0, LLM_BATCH_CAP);
      const byId = new Map(batch.map((event) => [event.eventId, event]));
      const pass = await llmVerdictPass({
        userId,
        context,
        idKey: 'eventId',
        noun: 'calendar events',
        itemsBlock: eventsBlock(batch),
        ids: new Set(byId.keys()),
      });
      for (const [id, area] of pass.assigned) {
        const event = byId.get(id)!;
        links.push({
          areaId: String(area._id),
          artifactKind: 'calendarEvent',
          artifactId: event.eventId,
          accountId: event.accountId,
          status: 'candidate',
          confidence: 0.6,
          reason: `llm high-confidence match to ${area.name}`,
        });
        settled.add(id);
        totals.llm += 1;
      }
      for (const id of pass.unassigned) {
        const event = byId.get(id)!;
        links.push(
          personalFallbackLink(context.personalAreaId, {
            kind: 'calendarEvent',
            artifactId: event.eventId,
            accountId: event.accountId,
          }),
        );
        settled.add(id);
        totals.personal += 1;
      }
      for (const event of batch) {
        if (settled.has(event.eventId)) continue;
        settled.add(event.eventId);
        totals.skipped += 1;
      }
    }

    if (links.length) {
      await deps.convexMutation(albatross.recordAreaLinks, { userId, links });
    }
    if (fetched.length < FETCH_LIMIT && events.every((event) => settled.has(event.eventId))) break;
    if (!links.length) break;
  }
  return totals;
}

export interface IntentClassifyResult {
  assigned: number;
  keptPersonal: number;
  skipped: number;
}

/**
 * Re-home intents that were captured without an area (they default to
 * Personal, flagged areaAutoAssigned). One fast-model pass; a confident match
 * moves the intent, anything else clears the flag so it stays in Personal.
 */
export async function classifyIntents({ userId }: { userId: string }): Promise<IntentClassifyResult> {
  const albatrossIntents = (deps.api as any).albatrossIntents;
  const intents = await deps.convexQuery<ClassifiableIntent[]>(albatrossIntents.listAutoAssigned, {
    userId,
    limit: LLM_BATCH_CAP,
  });
  if (!intents.length) return { assigned: 0, keptPersonal: 0, skipped: 0 };

  const context = await loadAreaContext(userId);
  if (!context.nonPersonalAreas.length) {
    // Personal is the only area — nothing to re-home to; settle the flags.
    await deps.convexMutation(albatrossIntents.applyAreaVerdicts, {
      userId,
      verdicts: intents.map((intent) => ({ intentId: intent.intentId })),
    });
    return { assigned: 0, keptPersonal: intents.length, skipped: 0 };
  }

  const byId = new Map(intents.map((intent) => [intent.intentId, intent]));
  const pass = await llmVerdictPass({
    userId,
    context,
    idKey: 'intentId',
    noun: 'captured intents (short tasks and plans the user wrote down)',
    itemsBlock: intentsBlock(intents),
    ids: new Set(byId.keys()),
  });
  const verdicts: Array<{ intentId: string; areaId?: string; reason?: string }> = [];
  for (const [id, area] of pass.assigned) {
    if (String(area._id) === context.personalAreaId) {
      verdicts.push({ intentId: id });
    } else {
      verdicts.push({
        intentId: id,
        areaId: String(area._id),
        reason: `llm high-confidence match to ${area.name}`,
      });
    }
  }
  for (const id of pass.unassigned) verdicts.push({ intentId: id });
  // Unanswered intents keep their flag and retry next tick.
  const skipped = intents.length - verdicts.length;
  if (!verdicts.length) return { assigned: 0, keptPersonal: 0, skipped };
  await deps.convexMutation(albatrossIntents.applyAreaVerdicts, { userId, verdicts });
  return {
    assigned: verdicts.filter((verdict) => verdict.areaId).length,
    keptPersonal: verdicts.filter((verdict) => !verdict.areaId).length,
    skipped,
  };
}

export interface AreaClassificationRun {
  threads: ClassifyResult | { error: string };
  events: ClassifyResult | { error: string };
  intents: IntentClassifyResult | { error: string };
}

/**
 * The full cron pass: mail threads, then calendar events, then intents. Each
 * section is isolated — one failing (Convex hiccup, model outage) never blocks
 * the others; failures surface in the returned counts and retry next tick.
 */
export async function runAreaClassification({ userId }: { userId: string }): Promise<AreaClassificationRun> {
  const safely = async <T>(label: string, run: () => Promise<T>): Promise<T | { error: string }> => {
    try {
      return await run();
    } catch (err: any) {
      console.error(`[area-classifier] ${label} pass failed for ${userId}:`, err);
      return { error: err?.message || `${label} classification failed` };
    }
  };
  return {
    threads: await safely('mail', () => classifyThreads({ userId })),
    events: await safely('calendar', () => classifyCalendarEvents({ userId })),
    intents: await safely('intent', () => classifyIntents({ userId })),
  };
}
