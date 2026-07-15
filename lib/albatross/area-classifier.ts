import { z } from 'zod';
import { generateTextForCurrentUser } from '@/lib/ai/gateway';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { matchAreaContext } from './area-matching';

// Background area classification: file recent unclaimed mail threads into the
// user's areas. Two phases, cheapest first:
//   1. Deterministic — the sender's address or domain exactly matches an area
//      fact. A verified fact yields a VERIFIED link (trust inherited from the
//      user's own confirmation of that fact); a candidate fact yields a
//      candidate link.
//   2. One nano-LLM verdict for whatever remains (capped per run). The model
//      can only ever produce CANDIDATE links — verification stays human.
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

export interface ClassifiableThread {
  providerThreadId: string;
  accountId: string;
  subject: string;
  fromAddress: string;
  lastDate: number;
  snippet?: string;
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
  const rank = (match: FactMatch) =>
    (match.status === 'verified' ? 2 : 0) + (match.matchType === 'email' ? 1 : 0);
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
    if (!best || rank(match) > rank(best)) best = match;
  }
  return best;
}

const verdictSchema = z.object({
  threadId: z.string().min(1),
  areaName: z.string().nullish(),
  confidence: z.enum(['high', 'medium', 'low']).catch('low'),
});

export type ClassifierVerdict = z.infer<typeof verdictSchema>;

/**
 * Parse the model's JSON verdict list defensively: strip fences, find the
 * array, drop malformed entries individually. Any unrecoverable output means
 * an empty verdict list — never a throw.
 */
export function parseClassifierOutput(raw: string): ClassifierVerdict[] {
  try {
    let text = (raw || '').trim();
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) text = fence[1].trim();
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end <= start) return [];
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    const verdicts: ClassifierVerdict[] = [];
    for (const entry of parsed) {
      const result = verdictSchema.safeParse(entry);
      if (result.success) verdicts.push(result.data);
    }
    return verdicts;
  } catch {
    return [];
  }
}

const CLASSIFY_SYSTEM = `You assign mail threads to the user's life areas. You get the areas with their known facts, then a list of threads (id, sender, subject).

Rules:
- Only assign a thread when its sender or subject clearly belongs to one area's facts or obvious scope. When unsure, use null.
- confidence "high" means you would defend the assignment from the listed facts alone. Anything weaker is "medium" or "low".
- Respond with ONE JSON array, no prose: [{"threadId": string, "areaName": string|null, "confidence": "high"|"medium"|"low"}]. Include every thread exactly once. areaName must be copied exactly from the provided area names.`;

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
        `- id=${thread.providerThreadId} | from=${extractEmail(thread.fromAddress) || thread.fromAddress} | subject=${(thread.subject || '(no subject)').slice(0, 120)}`,
    )
    .join('\n');
}

interface LinkWrite {
  areaId: string;
  artifactId: string;
  accountId?: string;
  status: 'candidate' | 'verified';
  confidence?: number;
  reason?: string;
  sourceRefs?: Array<Record<string, unknown>>;
  confirmationRefs?: Array<Record<string, unknown>>;
}

function deterministicLink(thread: ClassifiableThread, match: FactMatch): LinkWrite {
  const base: LinkWrite = {
    areaId: match.areaId,
    artifactId: thread.providerThreadId,
    accountId: thread.accountId,
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

export interface ClassifyResult {
  deterministic: number;
  llm: number;
  skipped: number;
}

export async function classifyThreads({ userId }: { userId: string }): Promise<ClassifyResult> {
  const albatross = (deps.api as any).albatross;
  const [areas, verifiedFacts, candidateFacts, threads] = await Promise.all([
    deps.convexQuery<any[]>(albatross.listAreas, { userId, status: 'active' }),
    deps.convexQuery<AreaFactLite[]>(albatross.listUserAreaFacts, { userId, status: 'verified' }),
    deps.convexQuery<AreaFactLite[]>(albatross.listUserAreaFacts, { userId, status: 'candidate' }),
    deps.convexQuery<ClassifiableThread[]>(albatross.unclassifiedThreads, { userId, limit: 50 }),
  ]);

  if (!threads.length) return { deterministic: 0, llm: 0, skipped: 0 };
  if (!areas.length) return { deterministic: 0, llm: 0, skipped: threads.length };

  const activeAreaIds = new Set(areas.map((area) => String(area._id)));
  const facts = [...verifiedFacts, ...candidateFacts].filter((fact) =>
    activeAreaIds.has(String(fact.areaId)),
  );
  const factsByArea = new Map<string, AreaFactLite[]>();
  for (const fact of facts) {
    const key = String(fact.areaId);
    factsByArea.set(key, [...(factsByArea.get(key) || []), fact]);
  }

  const links: LinkWrite[] = [];
  const remaining: ClassifiableThread[] = [];
  for (const thread of threads) {
    const match = matchThreadToFacts(thread, facts);
    if (match) {
      links.push(deterministicLink(thread, match));
      continue;
    }
    const contextMatch = matchAreaContext({
      text: [thread.subject, thread.snippet, thread.fromAddress].filter(Boolean).join(' '),
      areas: areas.map((area) => ({
        _id: String(area._id),
        name: String(area.name),
        kind: area.kind,
        description: area.description,
        primaryDomain: area.primaryDomain,
      })),
      facts: facts.map((fact) => ({ ...fact, areaId: String(fact.areaId) })),
    });
    if (contextMatch) {
      links.push({
        areaId: contextMatch.areaId,
        artifactId: thread.providerThreadId,
        accountId: thread.accountId,
        status: 'candidate',
        confidence: contextMatch.confidence,
        reason: contextMatch.reason,
        sourceRefs: contextMatch.signals.map((label, index) => ({
          kind: 'areaContext',
          id: `${contextMatch.areaId}:${index}`,
          label,
        })),
      });
      continue;
    }
    remaining.push(thread);
  }
  const deterministic = links.length;

  let llm = 0;
  let skipped = 0;
  if (remaining.length) {
    const batch = remaining.slice(0, LLM_BATCH_CAP);
    skipped += remaining.length - batch.length;
    const areaByName = new Map(areas.map((area) => [String(area.name).toLowerCase(), area]));
    const threadById = new Map(batch.map((thread) => [thread.providerThreadId, thread]));
    const claimed = new Set<string>();
    try {
      const { text } = await deps.generateTextForCurrentUser({
        feature: 'albatross_classify',
        speed: 'fast',
        userId,
        system: CLASSIFY_SYSTEM,
        prompt: `## Areas\n${areasBlock(areas, factsByArea)}\n\n## Threads\n${threadsBlock(batch)}`,
      });
      for (const verdict of parseClassifierOutput(text)) {
        const thread = threadById.get(verdict.threadId);
        if (!thread || claimed.has(verdict.threadId)) continue;
        claimed.add(verdict.threadId);
        const area = verdict.areaName ? areaByName.get(verdict.areaName.toLowerCase()) : undefined;
        if (!area || verdict.confidence !== 'high') {
          skipped += 1;
          continue;
        }
        // LLM verdicts are NEVER verified — candidate only, human confirms.
        links.push({
          areaId: String(area._id),
          artifactId: thread.providerThreadId,
          accountId: thread.accountId,
          status: 'candidate',
          confidence: 0.6,
          reason: `llm high-confidence match to ${area.name}`,
        });
        llm += 1;
      }
    } catch (err) {
      console.warn('[area-classifier] llm phase failed:', err);
    }
    // Threads the model never answered for (or the whole call failing) skip.
    skipped += batch.filter((thread) => !claimed.has(thread.providerThreadId)).length;
  }

  if (links.length) {
    await deps.convexMutation(albatross.recordAreaLinks, { userId, links });
  }
  return { deterministic, llm, skipped };
}
