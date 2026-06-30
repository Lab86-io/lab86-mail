import seed from '@/fixtures/albatross-0.9.seed.json';

export interface AlbatrossDailyReportArea {
  areaId: string;
  name: string;
  reason: string;
  loudness?: number;
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
  askBeforeCentering: Array<{ areaId: string; name: string; prompt: string; loudness?: number }>;
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
}

function dayKey(ts: number) {
  return new Date(ts).toISOString().slice(0, 10);
}

function monthDay(ts: number) {
  return new Date(ts).getUTCDate();
}

function table(seedData: any, key: string): any[] {
  return Array.isArray(seedData?.tables?.[key]) ? seedData.tables[key] : [];
}

function areaName(areasById: Map<string, any>, areaId: string) {
  return areasById.get(areaId)?.name || areaId;
}

export function buildAlbatrossDailyReportContext(
  input: BuildAlbatrossDailyReportInput = {},
): AlbatrossDailyReportContext {
  const seedData = input.seedData || seed;
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
      monthDay(now) === 1
        ? 'First report of the month: review active areas, paused projects, and stale context before prioritizing today.'
        : undefined,
  };
}

export function summarizeAlbatrossDailyReportContext(context: AlbatrossDailyReportContext): string {
  const parts: string[] = [];
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
  if (context.monthlyPrompt) parts.push(context.monthlyPrompt);
  return parts.join(' ');
}
