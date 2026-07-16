import { z } from 'zod';
import { generateTextForCurrentUser } from '@/lib/ai/gateway';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import type { AreaFactLite } from './area-classifier';
import { matchAreaContext } from './area-matching';

const defaultDeps = {
  api: api as any,
  convexQuery,
  convexMutation,
  generateTextForCurrentUser,
};

let deps = defaultDeps;

export function __setAreaDiscoveryDepsForTest(overrides: Partial<typeof defaultDeps> = {}) {
  deps = { ...defaultDeps, ...overrides };
}

export const AREA_DISCOVERY_LLM_CAP = 30;

export interface ClassifiableAreaArtifact {
  artifactKind: 'mailThread' | 'calendarEvent' | 'task' | 'mcpItem';
  artifactId: string;
  externalId?: string;
  accountId?: string;
  source: string;
  title: string;
  text: string;
  occurredAt: number;
  rejectedAreaIds?: string[];
}

export interface AreaDiscoveryMatch {
  areaId: string;
  areaName: string;
  artifactKind: ClassifiableAreaArtifact['artifactKind'];
  artifactId: string;
  source: string;
  title: string;
  confidence: number;
  reason: string;
}

const verdictSchema = z.object({
  candidateId: z.string().min(1),
  areaName: z.string().nullish(),
  confidence: z.enum(['high', 'medium', 'low']).catch('low'),
  reason: z.string().max(300).optional(),
});

type DiscoveryVerdict = z.infer<typeof verdictSchema>;

export function parseAreaDiscoveryOutput(raw: string): DiscoveryVerdict[] {
  try {
    let text = String(raw || '').trim();
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/iu);
    if (fence) text = fence[1].trim();
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end <= start) return [];
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      const result = verdictSchema.safeParse(entry);
      return result.success ? [result.data] : [];
    });
  } catch {
    return [];
  }
}

function candidateId(artifact: ClassifiableAreaArtifact) {
  return `${artifact.artifactKind}:${artifact.accountId || '-'}:${artifact.artifactId}`;
}

function sourceRef(artifact: ClassifiableAreaArtifact) {
  return {
    kind: artifact.artifactKind,
    id: artifact.artifactId,
    label: `${artifact.source}: ${artifact.title}`.slice(0, 200),
    ...(artifact.accountId ? { accountId: artifact.accountId } : {}),
  };
}

function hasStrongIdentitySignal(signals: string[]) {
  return signals.some((signal) =>
    /^(?:Area name|Area domain|domain:|repository:|repo:|organization:|product:|website:|url:)/iu.test(
      signal,
    ),
  );
}

const DISCOVERY_SYSTEM = `You classify recent evidence from mail, calendar, tasks, and connected tools into the user's Areas.

Rules:
- Use the Area name, description, domain, repository/project facts, people, and recurring terminology together. A GitHub/Slack/Granola sender domain does not need to match when the repository, meeting, issue, message, or subject clearly belongs.
- Assign only when the relationship is strong enough to ask the user for confirmation. Use null when uncertain.
- A candidate may list doNotAssignAreaIds from prior user rejections. Never assign it to those Areas.
- Never turn evidence into a verified fact. These are candidate relationships only.
- Return one JSON array and no prose: [{"candidateId":string,"areaName":string|null,"confidence":"high"|"medium"|"low","reason":string}]. Include every candidate exactly once and copy Area names exactly.`;

function areasPrompt(areas: any[], facts: AreaFactLite[]) {
  const byArea = new Map<string, AreaFactLite[]>();
  for (const fact of facts) {
    byArea.set(String(fact.areaId), [...(byArea.get(String(fact.areaId)) || []), fact]);
  }
  return areas
    .map((area) => {
      const details = [
        area.description ? `description: ${area.description}` : '',
        area.primaryDomain ? `domain: ${area.primaryDomain}` : '',
        ...(byArea.get(String(area._id)) || [])
          .slice(0, 18)
          .map((fact) => `[${fact.status}] ${fact.kind}: ${fact.value}`),
      ].filter(Boolean);
      return `- ${area.name} (${area.kind || 'area'})\n  ${details.join('\n  ')}`;
    })
    .join('\n');
}

function artifactsPrompt(artifacts: ClassifiableAreaArtifact[]) {
  return artifacts
    .map(
      (artifact) =>
        `- candidateId=${candidateId(artifact)} | source=${artifact.source} | title=${artifact.title.slice(0, 180)}${artifact.rejectedAreaIds?.length ? ` | doNotAssignAreaIds=${artifact.rejectedAreaIds.join(',')}` : ''} | context=${artifact.text.replace(/\s+/gu, ' ').slice(0, 700)}`,
    )
    .join('\n');
}

export async function classifyAreaArtifacts(input: { userId: string; areaId?: string }): Promise<{
  deterministic: number;
  llm: number;
  personal: number;
  skipped: number;
  sources: string[];
  discoveries: AreaDiscoveryMatch[];
}> {
  const albatross = (deps.api as any).albatross;
  const [allAreas, verifiedFacts, candidateFacts, corpus] = await Promise.all([
    deps.convexQuery<any[]>(albatross.listAreas, { userId: input.userId, status: 'active' }),
    deps.convexQuery<AreaFactLite[]>(albatross.listUserAreaFacts, {
      userId: input.userId,
      status: 'verified',
    }),
    deps.convexQuery<AreaFactLite[]>(albatross.listUserAreaFacts, {
      userId: input.userId,
      status: 'candidate',
    }),
    deps.convexQuery<{ items: ClassifiableAreaArtifact[]; sources: string[] }>(
      albatross.unclassifiedAreaArtifacts,
      { userId: input.userId, limit: 100 },
    ),
  ]);
  const areas = input.areaId ? allAreas.filter((area) => String(area._id) === input.areaId) : allAreas;
  const areaIds = new Set(areas.map((area) => String(area._id)));
  const facts = [...verifiedFacts, ...candidateFacts].filter((fact) => areaIds.has(String(fact.areaId)));
  // Mail has its own per-message, full-body structured classifier. Keeping it
  // out of this cross-source title/context pass prevents a cheaper heuristic
  // path from racing in a weak Area link.
  const artifacts = (corpus?.items || []).filter((artifact) => artifact.artifactKind !== 'mailThread');
  const sources = corpus?.sources || [];

  if (!artifacts.length || !areas.length) {
    return {
      deterministic: 0,
      llm: 0,
      personal: 0,
      skipped: artifacts.length,
      sources,
      discoveries: [],
    };
  }

  const links: Array<Record<string, unknown>> = [];
  const discoveries: AreaDiscoveryMatch[] = [];
  const remaining: ClassifiableAreaArtifact[] = [];
  let rejectedEverywhere = 0;
  for (const artifact of artifacts) {
    const rejectedAreaIds = new Set(artifact.rejectedAreaIds || []);
    const eligibleAreas = areas.filter((area) => !rejectedAreaIds.has(String(area._id)));
    if (!eligibleAreas.length) {
      rejectedEverywhere += 1;
      continue;
    }
    const match = matchAreaContext({
      text: artifact.text,
      areas: eligibleAreas.map((area) => ({
        _id: String(area._id),
        name: String(area.name),
        kind: area.kind,
        description: area.description,
        primaryDomain: area.primaryDomain,
      })),
      facts: facts.map((fact) => ({ ...fact, areaId: String(fact.areaId) })),
    });
    // Descriptive prose and long note facts are useful context for the model,
    // but too broad for a deterministic filing decision. Reserve the direct
    // path for names/domains/repos/orgs; semantic relationships go through
    // the conservative high-confidence agentic pass below.
    if (!match || !hasStrongIdentitySignal(match.signals)) {
      remaining.push(artifact);
      continue;
    }
    links.push({
      areaId: match.areaId,
      artifactKind: artifact.artifactKind,
      artifactId: artifact.artifactId,
      externalId: artifact.externalId,
      accountId: artifact.accountId,
      status: 'candidate',
      confidence: match.confidence,
      reason: match.reason,
      sourceRefs: [sourceRef(artifact)],
    });
    discoveries.push({
      areaId: match.areaId,
      areaName: match.areaName,
      artifactKind: artifact.artifactKind,
      artifactId: artifact.artifactId,
      source: artifact.source,
      title: artifact.title,
      confidence: match.confidence,
      reason: match.reason,
    });
  }

  const deterministic = links.length;
  let llm = 0;
  let skipped = rejectedEverywhere + Math.max(0, remaining.length - AREA_DISCOVERY_LLM_CAP);
  const batch = remaining.slice(0, AREA_DISCOVERY_LLM_CAP);
  if (batch.length) {
    const byCandidate = new Map(batch.map((artifact) => [candidateId(artifact), artifact]));
    const areaByName = new Map(areas.map((area) => [String(area.name).toLowerCase(), area]));
    const answered = new Set<string>();
    try {
      const { text } = await deps.generateTextForCurrentUser({
        feature: 'albatross_area_discovery',
        speed: 'fast',
        userId: input.userId,
        system: DISCOVERY_SYSTEM,
        prompt: `## Areas\n${areasPrompt(areas, facts)}\n\n## Recent unclaimed evidence\n${artifactsPrompt(batch)}`,
      });
      for (const verdict of parseAreaDiscoveryOutput(text)) {
        const artifact = byCandidate.get(verdict.candidateId);
        if (!artifact || answered.has(verdict.candidateId)) continue;
        answered.add(verdict.candidateId);
        const area = verdict.areaName ? areaByName.get(verdict.areaName.toLowerCase()) : undefined;
        if (!area || verdict.confidence !== 'high' || artifact.rejectedAreaIds?.includes(String(area._id))) {
          // Zero Areas is a successful sparse verdict. Smart Categories and
          // search keep unassigned mail visible; discovery never invents a
          // catch-all link.
          skipped += 1;
          continue;
        }
        const reason = `agentic discovery: ${verdict.reason || `semantic match to ${area.name}`}`;
        links.push({
          areaId: String(area._id),
          artifactKind: artifact.artifactKind,
          artifactId: artifact.artifactId,
          externalId: artifact.externalId,
          accountId: artifact.accountId,
          status: 'candidate',
          confidence: 0.62,
          reason,
          sourceRefs: [sourceRef(artifact)],
        });
        discoveries.push({
          areaId: String(area._id),
          areaName: String(area.name),
          artifactKind: artifact.artifactKind,
          artifactId: artifact.artifactId,
          source: artifact.source,
          title: artifact.title,
          confidence: 0.62,
          reason,
        });
        llm += 1;
      }
    } catch (error) {
      console.warn('[area-discovery] agentic pass failed:', error);
    }
    skipped += batch.filter((artifact) => !answered.has(candidateId(artifact))).length;
  }

  if (links.length) {
    await deps.convexMutation(albatross.recordAreaLinks, { userId: input.userId, links });
  }
  return { deterministic, llm, personal: 0, skipped, sources, discoveries };
}

async function areaDiscoveryBrief(input: { userId: string; areaId?: string }) {
  const brief = await deps.convexQuery<any>((deps.api as any).albatross.areaDiscoveryBrief, {
    userId: input.userId,
    areaId: input.areaId,
    limit: 20,
  });
  const candidates = (brief?.candidates || []) as AreaDiscoveryMatch[];
  const candidateFacts = (brief?.candidateFacts || []) as Array<{
    areaName: string;
    kind: string;
    value: string;
  }>;
  const lines = candidates
    .slice(0, 12)
    .map(
      (candidate) =>
        `- ${candidate.areaName} ↔ ${candidate.source}: ${candidate.title} (${candidate.reason || 'possible relationship'})`,
    );
  const factLines = candidateFacts
    .slice(0, 8)
    .map((fact) => `- ${fact.areaName} candidate ${fact.kind}: ${fact.value}`);
  return { candidates, candidateFacts, lines, factLines };
}

function systemContextFor(sources: string[], brief: Awaited<ReturnType<typeof areaDiscoveryBrief>>) {
  return `Automatic Area discovery searched: ${sources.join(', ') || 'no connected corpora yet'}.
${brief.lines.length ? `Possible relationships awaiting confirmation:\n${brief.lines.join('\n')}` : 'No unconfirmed artifact relationships are currently queued.'}
${brief.factLines.length ? `Candidate durable facts awaiting confirmation:\n${brief.factLines.join('\n')}` : ''}
When a possible relationship is present, ask one focused confirmation question about the strongest useful item in this turn. Explain which source suggested it. Do not verify a relationship or durable fact without the user's explicit answer. Do not repeat a question already answered in the transcript.`;
}

export async function readAreaDiscoveryContext(input: { userId: string; areaId?: string }) {
  const [brief, corpus] = await Promise.all([
    areaDiscoveryBrief(input),
    deps.convexQuery<{ sources?: string[] }>(deps.api.albatross.unclassifiedAreaArtifacts, {
      userId: input.userId,
      limit: 1,
    }),
  ]);
  const sources = [...new Set((corpus.sources || []).filter(Boolean))];
  return {
    sources,
    pendingCandidates: brief.candidates,
    pendingFacts: brief.candidateFacts,
    systemContext: systemContextFor(sources, brief),
  };
}

export async function prepareAreaDiscoveryContext(input: { userId: string; areaId?: string }) {
  const result = await classifyAreaArtifacts(input);
  const brief = await areaDiscoveryBrief(input);
  return {
    ...result,
    pendingCandidates: brief.candidates,
    pendingFacts: brief.candidateFacts,
    systemContext: systemContextFor(result.sources, brief),
  };
}
