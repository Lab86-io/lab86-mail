import { api, convexQuery } from '../hosted/convex';
import { isConvexConfigured } from '../hosted/env';
import { areaBrandingFromFacts } from './area-home';

export interface AlbatrossDailyReportArea {
  areaId: string;
  name: string;
  reason: string;
  loudness?: number;
  primaryDomain?: string | null;
  faviconUrl?: string | null;
  imageUrl?: string | null;
}

export interface AlbatrossDailyReportIntent {
  id: string;
  text: string;
  areaId?: string;
  status?: string;
}

export interface AlbatrossDailyReportProject {
  id: string;
  title: string;
  areaId?: string;
  status?: string;
  outcome?: string;
}

export interface AlbatrossDailyReportContext {
  includedAreas: AlbatrossDailyReportArea[];
  askBeforeCentering: Array<{
    areaId: string;
    name: string;
    prompt: string;
    loudness?: number;
    primaryDomain?: string | null;
    faviconUrl?: string | null;
    imageUrl?: string | null;
  }>;
  activeIntents: AlbatrossDailyReportIntent[];
  activeProjects: AlbatrossDailyReportProject[];
  contextReview: Array<{ id: string; areaId?: string; title: string; reason?: string }>;
  completions: Array<{ id: string; areaId?: string; summary: string; completedAt?: string }>;
  monthlyPrompt?: string;
}

interface BuildAlbatrossDailyReportInput {
  now?: number;
  includeAreaIds?: string[];
  seedData?: any;
  isFirstOpenOfMonth?: boolean;
}

interface BuildAlbatrossDailyReportFromLiveInput {
  now?: number;
  isFirstOpenOfMonth?: boolean;
  projects?: any[];
  approvals?: any[];
  applications?: any[];
  sprints?: any[];
  areas?: any[];
}

interface LoadLiveAlbatrossDailyReportInput {
  userId?: string | null;
  now?: number;
  isFirstOpenOfMonth?: boolean;
  query?: (args: { userId: string; limit: number }) => Promise<BuildAlbatrossDailyReportFromLiveInput>;
}

function dayKey(ts: number) {
  return new Date(ts).toISOString().slice(0, 10);
}

function table(seedData: any, key: string): any[] {
  return Array.isArray(seedData?.tables?.[key]) ? seedData.tables[key] : [];
}

function areaName(areasById: Map<string, any>, areaId: string) {
  return areasById.get(areaId)?.name || areaId;
}

function readableAreaName(areaId: string) {
  return areaId
    .replace(/^area_/, '')
    .split(/[_-]+/g)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');
}

function completionTime(row: any): string | undefined {
  const value = row.completedAt ?? row.closedAt ?? row.updatedAt ?? row.createdAt;
  return typeof value === 'number' ? new Date(value).toISOString() : undefined;
}

function plural(count: number, one: string, many = `${one}s`) {
  return count === 1 ? one : many;
}

export function buildAlbatrossDailyReportContext(
  input: BuildAlbatrossDailyReportInput = {},
): AlbatrossDailyReportContext {
  const seedData = input.seedData || { tables: {} };
  const now = input.now || Date.now();
  const today = dayKey(now);
  const includeAreaIds = new Set(input.includeAreaIds || []);
  const areas = table(seedData, 'areas');
  const areasById = new Map(areas.map((area) => [area.id, area]));
  const signals = table(seedData, 'dailyReportSignals').filter((signal) => signal.date === today);
  const includedAreaIds = new Set<string>();
  const includedAreas: AlbatrossDailyReportArea[] = [];
  const askBeforeCentering: AlbatrossDailyReportContext['askBeforeCentering'] = [];

  for (const signal of signals) {
    const name = areaName(areasById, signal.areaId);
    if (includeAreaIds.has(signal.areaId) || signal.reportBehavior === 'include_even_if_quiet') {
      includedAreaIds.add(signal.areaId);
      includedAreas.push({
        areaId: signal.areaId,
        name,
        loudness: signal.loudness,
        reason:
          signal.declaredPriority === 'active_intent'
            ? 'Active declared intent'
            : includeAreaIds.has(signal.areaId)
              ? 'Explicitly included today'
              : 'Included by report policy',
      });
      continue;
    }
    if (signal.reportBehavior === 'ask_before_centering') {
      askBeforeCentering.push({
        areaId: signal.areaId,
        name,
        prompt: signal.prompt,
        loudness: signal.loudness,
      });
    }
  }

  const intents = table(seedData, 'intents');
  for (const intent of intents) {
    if (intent.likelyAreaId && includedAreaIds.has(intent.likelyAreaId)) continue;
    if (
      intent.likelyAreaId &&
      (intent.status === 'draft_plan_ready' || intent.status === 'needs_questions')
    ) {
      includedAreaIds.add(intent.likelyAreaId);
    }
  }

  const activeIntents = intents
    .filter((intent) => intent.likelyAreaId && includedAreaIds.has(intent.likelyAreaId))
    .map((intent) => ({
      id: intent.id,
      text: intent.rawInput,
      areaId: intent.likelyAreaId,
      status: intent.status,
    }))
    .slice(0, 6);

  const activeProjects = table(seedData, 'projects')
    .filter(
      (project) =>
        project.status === 'active' &&
        (includedAreaIds.has(project.areaId) ||
          (project.intentIds || []).some((intentId: string) =>
            activeIntents.some((intent) => intent.id === intentId),
          )),
    )
    .map((project) => ({
      id: project.id,
      title: project.title,
      areaId: project.areaId,
      status: project.status,
      outcome: project.outcome,
    }))
    .slice(0, 5);

  const contextReview = table(seedData, 'contextReviewItems')
    .filter((item) => item.status !== 'resolved')
    .map((item) => ({
      id: item.id,
      areaId: item.suggestedAreaId || item.areaId,
      title: item.title || item.artifactId || item.id,
      reason: item.reason,
    }))
    .slice(0, 4);

  const completions = table(seedData, 'completionEvents')
    .map((event) => ({
      id: event.id,
      areaId: event.areaId,
      summary: event.summary,
      completedAt: event.completedAt,
    }))
    .slice(0, 4);

  return {
    includedAreas,
    askBeforeCentering,
    activeIntents,
    activeProjects,
    contextReview,
    completions,
    monthlyPrompt:
      input.isFirstOpenOfMonth === true
        ? 'First report of the month: review active areas, paused projects, and stale context before prioritizing today.'
        : undefined,
  };
}

export function buildAlbatrossDailyReportContextFromLive(
  input: BuildAlbatrossDailyReportFromLiveInput = {},
): AlbatrossDailyReportContext {
  const projects = input.projects ?? [];
  const approvals = input.approvals ?? [];
  const applications = input.applications ?? [];
  const sprints = input.sprints ?? [];
  const areaRows = input.areas ?? [];
  const areaById = new Map(
    areaRows.map((area) => {
      const branding = areaBrandingFromFacts(area, []);
      return [
        String(area._id ?? area.id ?? area.areaId),
        {
          name: area.name || readableAreaName(String(area._id ?? area.id ?? area.areaId)),
          ...branding,
        },
      ] as const;
    }),
  );
  const activeProjects = projects
    .filter((project) => project.status === 'active')
    .map((project) => ({
      id: String(project._id ?? project.id ?? project.externalId ?? project.title),
      title: project.title,
      areaId: project.areaId,
      status: project.status,
      outcome: project.outcome,
    }))
    .slice(0, 5);

  const activeIntentIds = new Set<string>();
  const activeIntents = applications
    .filter((application) => application.status === 'queued' || application.status === 'partially_applied')
    .filter((application) => {
      if (!application.intentId || activeIntentIds.has(application.intentId)) return false;
      activeIntentIds.add(application.intentId);
      return true;
    })
    .map((application) => ({
      id: String(application.intentId),
      text: application.intentText || application.intentId,
      areaId: application.areaId,
      status: application.status,
    }))
    .slice(0, 6);

  const areaIds = new Set<string>();
  for (const row of [...activeProjects, ...activeIntents]) {
    if (row.areaId) areaIds.add(String(row.areaId));
  }
  const includedAreas = [...areaIds].slice(0, 6).map((areaId) => ({
    areaId,
    name: areaById.get(areaId)?.name || readableAreaName(areaId),
    reason: 'Live Albatross work',
    primaryDomain: areaById.get(areaId)?.primaryDomain ?? null,
    faviconUrl: areaById.get(areaId)?.faviconUrl ?? null,
    imageUrl: areaById.get(areaId)?.imageUrl ?? null,
  }));

  const pressureByArea = new Map<string, { approvals: number; unresolved: number }>();
  const addPressure = (areaId: unknown, kind: 'approvals' | 'unresolved') => {
    if (!areaId) return;
    const key = String(areaId);
    const current = pressureByArea.get(key) ?? { approvals: 0, unresolved: 0 };
    current[kind] += 1;
    pressureByArea.set(key, current);
  };
  for (const approval of approvals) {
    if (approval.status === 'pending' || approval.status === 'claiming')
      addPressure(approval.areaId, 'approvals');
  }
  for (const application of applications) {
    for (const artifact of application.unresolvedArtifacts ?? []) {
      addPressure(artifact.areaId ?? application.areaId, 'unresolved');
    }
  }
  const askBeforeCentering = [...pressureByArea.entries()]
    .filter(([areaId]) => !areaIds.has(areaId))
    .map(([areaId, pressure]) => {
      const signalParts = [
        pressure.approvals ? `${pressure.approvals} pending ${plural(pressure.approvals, 'approval')}` : null,
        pressure.unresolved
          ? `${pressure.unresolved} unresolved ${plural(pressure.unresolved, 'artifact')}`
          : null,
      ].filter(Boolean);
      const name = readableAreaName(areaId);
      const areaBranding = areaById.get(areaId);
      const displayName = areaBranding?.name || name;
      return {
        areaId,
        name: displayName,
        prompt: `${displayName} has ${signalParts.join(' and ')}. Include it in today's report?`,
        loudness: Math.min(100, 45 + pressure.approvals * 20 + pressure.unresolved * 15),
        primaryDomain: areaBranding?.primaryDomain ?? null,
        faviconUrl: areaBranding?.faviconUrl ?? null,
        imageUrl: areaBranding?.imageUrl ?? null,
      };
    })
    .sort((a, b) => (b.loudness ?? 0) - (a.loudness ?? 0))
    .slice(0, 4);

  const approvalReview = approvals
    .filter((approval) => approval.status === 'pending' || approval.status === 'claiming')
    .map((approval) => ({
      id: String(approval._id ?? approval.id ?? approval.title),
      areaId: approval.areaId,
      title: approval.title,
      reason: approval.risk || approval.detail || 'Waiting for approval',
    }));
  const unresolvedReview = applications.flatMap((application) =>
    (application.unresolvedArtifacts ?? []).map((artifact: any, index: number) => ({
      id: `${application._id ?? application.intentId}:unresolved:${index}`,
      areaId: artifact.areaId ?? application.areaId,
      title: artifact.title || artifact.kind || 'Unresolved Albatross artifact',
      reason: artifact.blockedReason || 'Needs more information before applying',
    })),
  );

  const projectCompletions = projects
    .filter((project) => project.status === 'done')
    .map((project) => ({
      id: String(project._id ?? project.id ?? project.title),
      areaId: project.areaId,
      summary: `Completed project: ${project.title}`,
      completedAt: completionTime(project),
    }));
  const sprintCompletions = sprints
    .filter((sprint) => sprint.status === 'closed')
    .map((sprint) => ({
      id: String(sprint._id ?? sprint.id ?? sprint.title),
      areaId: undefined,
      summary: `Closed sprint: ${sprint.title}`,
      completedAt: completionTime(sprint),
    }));
  const applicationCompletions = applications
    .filter((application) => application.status === 'applied')
    .map((application) => ({
      id: String(application._id ?? application.intentId),
      areaId: application.areaId,
      summary: application.intentText ? `Applied plan: ${application.intentText}` : 'Applied Albatross plan',
      completedAt: completionTime(application),
    }));

  return {
    includedAreas,
    askBeforeCentering,
    activeIntents,
    activeProjects,
    contextReview: [...approvalReview, ...unresolvedReview].slice(0, 4),
    completions: [...projectCompletions, ...sprintCompletions, ...applicationCompletions]
      .sort((a, b) => (Date.parse(b.completedAt || '') || 0) - (Date.parse(a.completedAt || '') || 0))
      .slice(0, 4),
    monthlyPrompt:
      input.isFirstOpenOfMonth === true
        ? 'First report of the month: review active areas, paused projects, and stale context before prioritizing today.'
        : undefined,
  };
}

export async function loadLiveAlbatrossDailyReportContext(
  input: LoadLiveAlbatrossDailyReportInput = {},
): Promise<AlbatrossDailyReportContext> {
  const now = input.now || Date.now();
  const empty = buildAlbatrossDailyReportContext({
    now,
    isFirstOpenOfMonth: input.isFirstOpenOfMonth,
  });
  if (!input.userId) return empty;
  if (!input.query && !isConvexConfigured()) return empty;

  try {
    const live = await (input.query
      ? input.query({ userId: input.userId, limit: 50 })
      : convexQuery<BuildAlbatrossDailyReportFromLiveInput>((api as any).albatrossWork.dailyReportContext, {
          userId: input.userId,
          limit: 50,
        }));
    return buildAlbatrossDailyReportContextFromLive({
      now,
      isFirstOpenOfMonth: input.isFirstOpenOfMonth,
      projects: live?.projects,
      approvals: live?.approvals,
      applications: live?.applications,
      sprints: live?.sprints,
      areas: live?.areas,
    });
  } catch (err: any) {
    console.warn('Daily report Albatross context failed:', err?.message || err);
    return empty;
  }
}

export function summarizeAlbatrossDailyReportContext(context: AlbatrossDailyReportContext): string {
  const parts: string[] = [];
  if (context.includedAreas.length) {
    parts.push(
      `Included Albatross areas: ${context.includedAreas
        .map((area) => `${area.name} (${area.reason})`)
        .slice(0, 4)
        .join(' | ')}`,
    );
  }
  if (context.activeIntents.length) {
    parts.push(
      `Active intents: ${context.activeIntents
        .map((intent) => intent.text)
        .slice(0, 3)
        .join(' | ')}`,
    );
  }
  if (context.activeProjects.length) {
    parts.push(
      `Active projects: ${context.activeProjects
        .map((project) => project.title)
        .slice(0, 3)
        .join(' | ')}`,
    );
  }
  if (context.askBeforeCentering.length) {
    parts.push(context.askBeforeCentering.map((item) => item.prompt).join(' '));
  }
  if (context.contextReview.length) {
    parts.push(
      `Context review: ${context.contextReview
        .map((item) => item.title)
        .slice(0, 3)
        .join(' | ')}`,
    );
  }
  if (context.completions.length) {
    parts.push(
      `Recent Albatross completions: ${context.completions
        .map((event) => event.summary)
        .slice(0, 3)
        .join(' | ')}`,
    );
  }
  if (context.monthlyPrompt) parts.push(context.monthlyPrompt);
  return parts.join(' ');
}
