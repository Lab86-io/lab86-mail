import { createHash } from 'node:crypto';
import { z } from 'zod';
import { generateTextForCurrentUser } from '../ai/gateway';
import { api, convexMutation, convexQuery } from '../hosted/convex';

const areaBriefSchema = z.object({
  lede: z.string().min(1).max(600),
  summary: z.string().min(1).max(2_000),
});

function parseBrief(raw: string, fallback: { lede: string; summary: string }) {
  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) return fallback;
    const parsed = areaBriefSchema.safeParse(JSON.parse(raw.slice(start, end + 1)));
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}

export async function generateAreaLivingBrief(input: {
  userId: string;
  userEmail?: string | null;
  userName?: string | null;
  areaId: string;
  // Skip the unchanged-revision short-circuit — the morning cron regenerates
  // every brief so each day opens on freshly written context.
  force?: boolean;
}) {
  const home = await convexQuery<any>((api as any).albatross.areaHome, {
    userId: input.userId,
    areaId: input.areaId,
  });
  const context = {
    area: {
      name: home.area.name,
      description: home.area.description,
      kind: home.area.kind,
    },
    work: (home.plans || []).map((row: any) => ({
      title: row.title,
      status: row.status,
      outcome: row.outcome,
      summary: row.summary,
    })),
    projects: (home.projects || []).map((row: any) => ({
      title: row.title,
      status: row.status,
      outcome: row.outcome,
    })),
    upcoming: (home.events || [])
      .filter((event: any) => event.endAt >= Date.now())
      .slice(0, 8)
      .map((event: any) => ({ title: event.title, startAt: event.startAt, location: event.location })),
    openTasks: (home.tasks || [])
      .filter((task: any) => !task.completedAt)
      .slice(0, 12)
      .map((task: any) => ({ title: task.title, dueAt: task.dueAt })),
    recentMail: (home.mail || []).slice(0, 8).map((mail: any) => ({
      subject: mail.subject,
      from: mail.fromAddress,
      snippet: mail.snippet,
    })),
    candidateContext: (home.facts?.candidate || []).slice(0, 8).map((fact: any) => ({
      kind: fact.kind,
      value: fact.value,
    })),
  };
  const revision = createHash('sha256').update(JSON.stringify(context)).digest('hex').slice(0, 24);
  if (!input.force && home.livingBrief?.status === 'ready' && home.livingBrief.basedOnRevision === revision) {
    return home.livingBrief;
  }
  await convexMutation((api as any).albatrossWorkV2.saveAreaBrief, {
    userId: input.userId,
    areaId: input.areaId,
    status: 'generating',
    lede: home.livingBrief?.lede || `${home.area.name} is being brought up to date.`,
    summary: home.livingBrief?.summary || 'Albatross is reviewing the latest Work and evidence.',
    sourceRefs: [],
    basedOnRevision: revision,
  });
  try {
    const { text } = await generateTextForCurrentUser({
      feature: 'albatross_area_brief',
      speed: 'fast',
      userId: input.userId,
      userEmail: input.userEmail,
      userName: input.userName,
      system: `Write the current editorial lead for one Area in a personal work system.
Return one JSON object only: {"lede":string,"summary":string}.
The lede is one concrete sentence about what is moving or needs attention. The summary is 2-4 short factual sentences. Declared Work outranks artifact volume. Candidate context is uncertain and must be phrased as a question or omitted. Do not invent progress, people, deadlines, or importance. No greeting, emoji, hype, first-person assistant voice, or generic productivity advice.`,
      prompt: JSON.stringify(context, null, 2),
    });
    const fallback = {
      lede: `${home.area.name} has ${home.counts?.plans || 0} active Work item${home.counts?.plans === 1 ? '' : 's'} and ${home.counts?.projects || 0} Project${home.counts?.projects === 1 ? '' : 's'}.`,
      summary: 'Open Work, scheduled commitments, and linked evidence are shown below.',
    };
    const brief = parseBrief(text, fallback);
    await convexMutation((api as any).albatrossWorkV2.saveAreaBrief, {
      userId: input.userId,
      areaId: input.areaId,
      status: 'ready',
      ...brief,
      sourceRefs: [],
      basedOnRevision: revision,
    });
    return { ...brief, status: 'ready', basedOnRevision: revision };
  } catch (error) {
    await convexMutation((api as any).albatrossWorkV2.saveAreaBrief, {
      userId: input.userId,
      areaId: input.areaId,
      status: 'error',
      lede: home.livingBrief?.lede || `${home.area.name} could not be refreshed.`,
      summary: home.livingBrief?.summary || 'Live Work and evidence remain available below.',
      sourceRefs: [],
      basedOnRevision: revision,
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
    throw error;
  }
}
