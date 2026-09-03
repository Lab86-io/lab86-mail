import { createHash } from 'node:crypto';
import { describeProvider } from '../ai/client';
import { generateTextForCurrentUser } from '../ai/gateway';
import { api, convexMutation, convexQuery } from '../hosted/convex';
import { sanitizeLine, sanitizeProse } from '../mail/brief-prose';
import { type BriefDocumentV2, type BriefRegion, parseBriefDocument } from '../shared/brief-document';
import { withDeadline } from '../shared/deadline';
import { injectAreaArtifactFontContract } from './area-artifact-fonts';
import { dailyIntentBudget, intentAppliesToScope } from './daily-intent';

// The area pulse (2026-09-03). One small model call writes four fields; the
// document and the HTML fallback are rendered from them deterministically.
const AREA_PULSE_DEADLINE_MS = 60_000;
export const AREA_PULSE_MAX_SENTENCES = 3;
export const AREA_PULSE_FIELD_MAX_WORDS = 28;

interface AreaLivingBriefDependencies {
  convexMutation: typeof convexMutation;
  convexQuery: typeof convexQuery;
  generateTextForCurrentUser: typeof generateTextForCurrentUser;
}

const defaultAreaLivingBriefDependencies: AreaLivingBriefDependencies = {
  convexMutation,
  convexQuery,
  generateTextForCurrentUser,
};

let areaLivingBriefDependencies = defaultAreaLivingBriefDependencies;

export function setAreaLivingBriefDependenciesForTest(overrides: Partial<AreaLivingBriefDependencies>) {
  const previous = areaLivingBriefDependencies;
  areaLivingBriefDependencies = { ...previous, ...overrides };
  return () => {
    areaLivingBriefDependencies = previous;
  };
}

type AreaHomeLike = {
  area: Record<string, any>;
  livingBrief?: Record<string, any> | null;
  facts?: { verified?: any[]; candidate?: any[] };
  mail?: any[];
  events?: any[];
  tasks?: any[];
  mcpItems?: any[];
  plans?: any[];
  projects?: any[];
  places?: any[];
  counts?: Record<string, any>;
  dailyAlignment?: {
    localDate?: string;
    reflection?: string | null;
    tomorrowIntent?: string | null;
  } | null;
};

function iso(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : null;
}

function clean(value: unknown, max: number) {
  return typeof value === 'string' ? value.trim().slice(0, max) : null;
}

/**
 * The complete, bounded read model given to the Area document composer. IDs
 * are included only where the host exposes a matching read/navigation action.
 * Candidate facts are segregated so they cannot masquerade as verified truth.
 */
export function buildAreaArtifactContext(
  home: AreaHomeLike,
  generatedAt = Date.now(),
  pulse?: Record<string, any> | null,
  evidenceIndex?: Record<string, any> | null,
) {
  const areaId = String(home.area?._id || '');
  const nextDayIntent = clean(home.dailyAlignment?.tomorrowIntent, 10_000);
  const intentLabels = [
    clean(home.area?.name, 180),
    clean(home.area?.description, 1_200),
    ...(home.plans || []).flatMap((row) => [clean(row.title, 240), clean(row.outcome, 1_200)]),
    ...(home.projects || []).flatMap((row) => [clean(row.title, 240), clean(row.outcome, 1_200)]),
    ...(home.tasks || []).map((row) => clean(row.title, 500)),
  ].filter((value): value is string => Boolean(value));
  const intentBudget = dailyIntentBudget(nextDayIntent);
  return {
    edition: {
      generatedAt,
      generatedAtIso: new Date(generatedAt).toISOString(),
      scope: 'one_area',
    },
    area: {
      areaId,
      name: clean(home.area?.name, 180),
      description: clean(home.area?.description, 1_200),
      kind: clean(home.area?.kind, 80),
      primaryDomain: clean(home.area?.primaryDomain, 240),
    },
    nextDayIntent: nextDayIntent
      ? {
          localDate: clean(home.dailyAlignment?.localDate, 20),
          text: nextDayIntent,
          appliesToArea: intentAppliesToScope(nextDayIntent, intentLabels),
          ...intentBudget,
        }
      : null,
    // In this read model, plans are the latest plan nested under each active
    // Work intent. Keep both identities explicit so the document never turns
    // Plans back into a standalone navigation destination.
    work: (home.plans || []).slice(0, 24).map((row) => ({
      workId: clean(row.intentId, 100),
      title: clean(row.title, 240),
      status: clean(row.status, 80),
      planStatus: clean(row.planStatus, 80),
      outcome: clean(row.outcome, 1_200),
      summary: clean(row.summary, 2_000),
      proposedProjectTitle: clean(row.proposedProjectTitle, 240),
      updatedAt: row.updatedAt ?? null,
      updatedAtIso: iso(row.updatedAt),
    })),
    projects: (home.projects || []).slice(0, 16).map((row) => ({
      projectId: clean(row.projectId, 100),
      sourceWorkId: clean(row.sourceIntentId, 100),
      title: clean(row.title, 240),
      outcome: clean(row.outcome, 1_200),
      status: clean(row.status, 80),
      taskCount: typeof row.taskCount === 'number' ? row.taskCount : 0,
      completedTaskCount: typeof row.completedTaskCount === 'number' ? row.completedTaskCount : 0,
      activeSprint: row.activeSprint
        ? {
            title: clean(row.activeSprint.title, 240),
            status: clean(row.activeSprint.status, 80),
            endAt: row.activeSprint.endAt ?? null,
            endAtIso: iso(row.activeSprint.endAt),
          }
        : null,
      updatedAt: row.updatedAt ?? null,
      updatedAtIso: iso(row.updatedAt),
    })),
    tasks: (home.tasks || []).slice(0, 40).map((row) => ({
      cardId: clean(String(row.cardId || ''), 100),
      title: clean(row.title, 500),
      completed: Boolean(row.completedAt),
      completedAtIso: iso(row.completedAt),
      dueAt: row.dueAt ?? null,
      dueAtIso: iso(row.dueAt),
      updatedAtIso: iso(row.updatedAt),
      assignment: row.linkStatus === 'candidate' ? 'candidate' : 'verified',
      assignmentReason: clean(row.reason, 500),
    })),
    events: (home.events || []).slice(0, 32).map((row) => ({
      accountId: clean(row.accountId, 180),
      eventId: clean(row.providerEventId, 180),
      title: clean(row.title, 500),
      startAt: row.startAt,
      startAtIso: iso(row.startAt),
      endAt: row.endAt,
      endAtIso: iso(row.endAt),
      allDay: Boolean(row.allDay),
      location: clean(row.location, 500),
      assignment: row.linkStatus === 'candidate' ? 'candidate' : 'verified',
      assignmentReason: clean(row.reason, 500),
    })),
    mail: (home.mail || []).slice(0, 32).map((row) => ({
      accountId: clean(row.accountId, 180),
      threadId: clean(row.providerThreadId, 180),
      subject: clean(row.subject, 500),
      from: clean(row.fromAddress, 300),
      receivedAt: row.lastDate,
      receivedAtIso: iso(row.lastDate),
      snippet: clean(row.snippet, 700),
      unread: Boolean(row.unread),
      assignment: row.linkStatus === 'candidate' ? 'candidate' : 'verified',
      assignmentReason: clean(row.reason, 500),
    })),
    connectedActivity: (home.mcpItems || []).slice(0, 32).map((row: any) => ({
      externalId: clean(row.externalId, 240),
      server: clean(row.server, 80),
      kind: clean(row.kind, 80),
      title: clean(row.title, 500),
      summary: clean(row.summary, 900),
      state: clean(row.state, 80),
      author: clean(row.author, 200),
      repository: clean(row.repository, 300),
      organization: clean(row.organization, 200),
      url: clean(row.url, 1_200),
      occurredAtIso: iso(row.occurredAt),
      assignment: row.linkStatus === 'candidate' ? 'candidate' : 'verified',
      assignmentReason: clean(row.reason, 500),
    })),
    places: (home.places || []).slice(0, 16).map((row) => ({
      name: clean(row.name, 300),
      detail: clean(row.detail, 500),
      address: clean(row.address, 500),
      hoursText: clean(row.hoursText, 500),
      website: clean(row.website, 500),
    })),
    context: {
      verified: (home.facts?.verified || []).slice(0, 32).map((fact) => ({
        kind: clean(fact.kind, 100),
        label: clean(fact.label, 200),
        value: clean(fact.value, 1_000),
      })),
      // These are hypotheses, never facts. The prompt requires question-like
      // framing or omission.
      candidates: (home.facts?.candidate || []).slice(0, 20).map((fact) => ({
        factId: clean(String(fact._id || ''), 100),
        kind: clean(fact.kind, 100),
        label: clean(fact.label, 200),
        value: clean(fact.value, 1_000),
        confidence: typeof fact.confidence === 'number' ? fact.confidence : null,
      })),
    },
    livingIndex: {
      totalEvidence: typeof evidenceIndex?.total === 'number' ? evidenceIndex.total : 0,
      strength: typeof evidenceIndex?.strength === 'number' ? evidenceIndex.strength : 0,
      bounded: Boolean(evidenceIndex?.bounded),
      sourceCounts: evidenceIndex?.sourceCounts || {},
      trustCounts: evidenceIndex?.trustCounts || {},
      note: 'Strength is bounded corroboration, not completion probability. Explicit answers and confirmed facts carry more weight than observed activity.',
    },
    projectPulse: (pulse?.projects || []).slice(0, 12).map((row: any) => ({
      projectId: clean(String(row.project?._id || ''), 100),
      title: clean(row.project?.title, 240),
      outcome: clean(row.project?.outcome, 1_200),
      status: clean(row.project?.status, 80),
      taskCount: typeof row.taskCount === 'number' ? row.taskCount : 0,
      completedTaskCount: typeof row.completedTaskCount === 'number' ? row.completedTaskCount : 0,
      todayTasks: (row.todayTasks || []).slice(0, 8).map((task: any) => ({
        title: clean(task.title, 500),
        dueAtIso: iso(task.dueAt),
      })),
      routines: (row.routines || []).slice(0, 8).map((routine: any) => ({
        routineId: clean(String(routine._id || ''), 100),
        title: clean(routine.title, 240),
        purpose: clean(routine.purpose, 800),
        kind: clean(routine.kind, 80),
        status: clean(routine.status, 80),
        consent: clean(routine.consent, 80),
        cadence: clean(routine.cadence, 80),
        localTime: clean(routine.localTime, 20),
        timezone: clean(routine.timezone, 100),
        nextRunAtIso: iso(routine.nextRunAt),
      })),
      pendingQuestions: (row.pendingQuestions || []).slice(0, 6).map((question: any) => ({
        questionId: clean(String(question._id || ''), 100),
        kind: clean(question.kind, 80),
        responseKind: clean(question.responseKind, 80),
        prompt: clean(question.prompt, 700),
        reason: clean(question.reason, 700),
        options: (question.options || []).slice(0, 8).map((option: any) => ({
          id: clean(option.id, 80),
          label: clean(option.label, 180),
          description: clean(option.description, 400),
        })),
      })),
    })),
    bounds: home.counts || {},
    actions: {
      openWork: { action: 'open_work', payload: { workId: '<work.workId>' } },
      openThread: {
        action: 'open_thread',
        payload: { accountId: '<mail.accountId>', threadId: '<mail.threadId>' },
      },
      openEvent: {
        action: 'open_event',
        payload: { accountId: '<events.accountId>', eventId: '<events.eventId>' },
      },
      openTasks: { action: 'open_tasks', payload: {} },
      discussArea: { action: 'discuss_area', payload: { areaId } },
      captureIntent: { action: 'capture_intent', payload: { areaId, text: '<user input>' } },
      answerQuestion: {
        action: 'answer_question',
        payload: { questionId: '<projectPulse.pendingQuestions.questionId>', text: '<user input>' },
      },
    },
  };
}

export function areaArtifactRevision(context: unknown) {
  const record = context && typeof context === 'object' ? (context as Record<string, any>) : {};
  // Edition time belongs in the composed document but is not source state. If
  // it participated in the digest, every background check would regenerate.
  const revisionInput = {
    ...record,
    edition: record.edition ? { scope: record.edition.scope } : undefined,
  };
  return createHash('sha256').update(JSON.stringify(revisionInput)).digest('hex').slice(0, 24);
}

const AREA_CSP =
  "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data: blob:; script-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/** Remove model-authored executable surfaces before the host injects its own runtime. */
export function normalizeAreaArtifactHtml(html: string) {
  let next = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<(?:iframe|object|embed)\b[^>]*>[\s\S]*?<\/(?:iframe|object|embed)>/gi, '')
    .replace(/<(?:iframe|object|embed|base)\b[^>]*\/?\s*>/gi, '')
    .replace(/<meta\b(?=[^>]*http-equiv\s*=\s*(["'])?refresh\1?)[^>]*>/gi, '')
    .replace(/<meta\b(?=[^>]*http-equiv\s*=\s*(["'])?content-security-policy\1?)[^>]*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(
      /(href|src|action|formaction|poster|xlink:href)\s*=\s*(["'])\s*(?:javascript:|vbscript:|data:text\/html)[\s\S]*?\2/gi,
      '$1="#"',
    );
  const csp = `<meta http-equiv="Content-Security-Policy" content="${AREA_CSP}">`;
  const head = next.search(/<head[\s>][^>]*>/i);
  if (head >= 0) {
    const close = next.indexOf('>', head);
    next = `${next.slice(0, close + 1)}${csp}${next.slice(close + 1)}`;
  } else {
    next = next.replace(/<html([^>]*)>/i, `<html$1><head>${csp}</head>`);
  }
  return injectAreaArtifactFontContract(next);
}

// ---- The pulse ---------------------------------------------------------------

export interface AreaPulse {
  lastChange: string;
  nextMove: string;
  openQuestion: string;
  // At most 3 sentences.
  prose: string;
  model?: string;
}

export const AREA_PULSE_SYSTEM_PROMPT = `You keep a short pulse for one area of a person's life or work. Return only JSON:
{"lastChange":"...","nextMove":"...","openQuestion":"...","prose":"..."}

Rules:
- lastChange: one sentence on the most recent real change in this area (a message, a task, a commit, an event). Use supplied dates. Empty string when nothing changed.
- nextMove: one sentence naming the single next useful action. Empty string when there is none.
- openQuestion: one question the person must answer to move this area forward. Use a supplied pending question when one exists. Empty string when there is none.
- prose: at most 3 sentences on where this area stands. Declared Work and the person's stated intent outrank the volume of mail or tasks.
- Use only supplied facts. Never say work is done unless a completed state says so. Candidate context is uncertain: phrase it as a question or leave it out.
- Plain English. Sentence case. No bullet lists, no headings, no emoji, no exclamation marks, no ALL-CAPS words. Never write the word "AI".`;

function firstString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

// A pulse from the context alone. Used when no model is available and as the
// floor under a thin model reply.
export function fallbackAreaPulse(context: Record<string, any>): AreaPulse {
  const name = firstString(context.area?.name, 180) || 'This area';
  const work = Array.isArray(context.work) ? context.work : [];
  const tasks = Array.isArray(context.tasks) ? context.tasks : [];
  const mail = Array.isArray(context.mail) ? context.mail : [];
  const events = Array.isArray(context.events) ? context.events : [];
  const questions = (Array.isArray(context.projectPulse) ? context.projectPulse : []).flatMap((row: any) =>
    Array.isArray(row?.pendingQuestions) ? row.pendingQuestions : [],
  );
  const latest = [...work, ...tasks, ...mail]
    .map((row: any) => ({
      at:
        Number(
          row.updatedAt ?? row.receivedAt ?? (row.updatedAtIso ? Date.parse(String(row.updatedAtIso)) : 0),
        ) || 0,
      text: firstString(row.title || row.subject, 200),
    }))
    .filter((row) => row.text)
    .sort((a, b) => b.at - a.at)[0];
  const openTask = tasks.find((row: any) => row?.title && !row.completed);
  const nextEvent = events.find((row: any) => row?.title);
  const openWork = work.length;
  const lastChange = latest ? `Latest: ${latest.text}.` : '';
  const nextMove = openTask
    ? `Next: ${firstString(openTask.title, 200)}.`
    : nextEvent
      ? `Next: ${firstString(nextEvent.title, 200)}.`
      : '';
  const openQuestion = questions[0]?.prompt ? firstString(questions[0].prompt, 300) : '';
  const prose = `${name} has ${openWork} active Work ${openWork === 1 ? 'item' : 'items'} and ${tasks.filter((row: any) => !row.completed).length} open ${tasks.length === 1 ? 'task' : 'tasks'}.`;
  return { lastChange, nextMove, openQuestion, prose, model: 'local' };
}

export function parseAreaPulse(text: string, fallback: AreaPulse): AreaPulse | null {
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const field = (value: unknown) =>
    sanitizeLine(typeof value === 'string' ? value : '', AREA_PULSE_FIELD_MAX_WORDS);
  return {
    lastChange: field(parsed.lastChange) || fallback.lastChange,
    nextMove: field(parsed.nextMove) || fallback.nextMove,
    openQuestion: field(parsed.openQuestion) || fallback.openQuestion,
    prose:
      sanitizeProse(typeof parsed.prose === 'string' ? parsed.prose : '', AREA_PULSE_MAX_SENTENCES) ||
      fallback.prose,
  };
}

export async function writeAreaPulse(
  context: Record<string, any>,
  input: { userId: string; userEmail?: string | null; userName?: string | null },
): Promise<AreaPulse> {
  const fallback = fallbackAreaPulse(context);
  try {
    const { text } = await withDeadline(
      areaLivingBriefDependencies.generateTextForCurrentUser({
        feature: 'albatross_area_pulse',
        speed: 'fast',
        userId: input.userId,
        userEmail: input.userEmail,
        userName: input.userName,
        system: AREA_PULSE_SYSTEM_PROMPT,
        prompt: JSON.stringify(context, null, 2),
      }),
      AREA_PULSE_DEADLINE_MS,
      'Area pulse composition',
    );
    const parsed = parseAreaPulse(text, fallback);
    if (!parsed) return fallback;
    return { ...parsed, model: describeProvider().fast || describeProvider().primary || 'fast' };
  } catch (error) {
    console.warn('[area-living-brief] pulse model call failed; using the deterministic pulse:', error);
    return fallback;
  }
}

// ---- Deterministic renderers -------------------------------------------------

// The area document: hero (prose) -> pulse lines -> one prompt -> live open work.
export function composeAreaPulseDocument(
  context: Record<string, any>,
  pulse: AreaPulse,
  generatedAt = Number(context.edition?.generatedAt) || Date.now(),
): BriefDocumentV2 {
  const areaId = String(context.area?.areaId || '');
  const areaName = String(context.area?.name || 'Area');
  const questions = (Array.isArray(context.projectPulse) ? context.projectPulse : []).flatMap((row: any) =>
    Array.isArray(row?.pendingQuestions) ? row.pendingQuestions : [],
  );
  const questionId = questions[0]?.questionId ? String(questions[0].questionId) : undefined;
  const lines = [
    pulse.lastChange ? `Last change: ${pulse.lastChange}` : '',
    pulse.nextMove ? `Next move: ${pulse.nextMove}` : '',
    pulse.openQuestion ? `Open question: ${pulse.openQuestion}` : '',
  ].filter(Boolean);
  const regions: BriefRegion[] = [
    {
      id: 'lede',
      summary: pulse.prose,
      tree: {
        kind: 'hero',
        emphasis: 'primary',
        tone: 'neutral',
        surface: 'plain',
        children: [{ kind: 'text', emphasis: 'primary', tone: 'neutral', role: 'lede', text: pulse.prose }],
      },
    },
  ];
  if (lines.length) {
    regions.push({
      id: 'pulse',
      summary: lines.join(' '),
      tree: {
        kind: 'stack',
        emphasis: 'standard',
        tone: 'neutral',
        density: 'standard',
        children: lines.map((text) => ({
          kind: 'text' as const,
          emphasis: 'standard' as const,
          tone: 'neutral' as const,
          role: 'body' as const,
          text,
        })),
      },
    });
  }
  regions.push({
    id: 'ask',
    summary: pulse.openQuestion || 'Add a thought to this area.',
    tree: questionId
      ? {
          kind: 'prompt',
          emphasis: 'standard',
          tone: 'neutral',
          variant: 'question',
          placeholder: pulse.openQuestion || 'Your answer',
          questionId,
        }
      : {
          kind: 'prompt',
          emphasis: 'muted',
          tone: 'neutral',
          variant: 'capture',
          placeholder: 'Get this out of my head',
        },
  });
  if (areaId) {
    regions.push({
      id: 'open-work',
      summary: 'Open work in this area.',
      tree: {
        kind: 'query_list',
        emphasis: 'standard',
        tone: 'neutral',
        title: 'Open work',
        query: { name: 'area_open_work', areaId },
        limit: 6,
        variant: 'rows',
        emptyText: 'No open work.',
      },
    });
  }
  return parseBriefDocument({
    version: 2,
    title: areaName,
    summary: pulse.prose,
    generatedAt,
    regions,
  });
}

// The small HTML fallback for readers without the v2 renderer.
export function renderAreaPulseHtml(areaName: string, pulse: AreaPulse): string {
  const line = (label: string, value: string) =>
    value ? `<p><strong>${escapeAreaHtml(label)}</strong> ${escapeAreaHtml(value)}</p>` : '';
  return normalizeAreaArtifactHtml(`<!doctype html>
<html><head><meta charset="utf-8"><style>
body{margin:0;padding:48px;font:16px/1.6 system-ui;background:#f7f5ef;color:#20231f}
main{max-width:760px;margin:auto}h1{font:700 42px/1.05 Georgia,serif}p{max-width:62ch}strong{font-weight:650}
</style></head><body><main><p>Area brief</p><h1>${escapeAreaHtml(areaName)}</h1>
<p>${escapeAreaHtml(pulse.prose)}</p>
${line('Last change.', pulse.lastChange)}${line('Next move.', pulse.nextMove)}${line('Open question.', pulse.openQuestion)}
</main></body></html>`);
}

function escapeAreaHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    if (character === '&') return '&amp;';
    if (character === '<') return '&lt;';
    if (character === '>') return '&gt;';
    if (character === '"') return '&quot;';
    return '&#39;';
  });
}

// ---- Generation --------------------------------------------------------------

export async function generateAreaLivingBrief(input: {
  userId: string;
  userEmail?: string | null;
  userName?: string | null;
  areaId: string;
  force?: boolean;
}) {
  const [home, pulseContext, evidenceIndex] = await Promise.all([
    areaLivingBriefDependencies.convexQuery<AreaHomeLike>((api as any).albatross.areaHome, {
      userId: input.userId,
      areaId: input.areaId,
    }),
    areaLivingBriefDependencies.convexQuery<Record<string, any>>((api as any).albatrossRoutines.areaPulse, {
      userId: input.userId,
      areaId: input.areaId,
    }),
    areaLivingBriefDependencies.convexQuery<Record<string, any>>(
      (api as any).albatrossEvidence.indexSummary,
      {
        userId: input.userId,
        targetKind: 'area',
        targetId: input.areaId,
      },
    ),
  ]);
  const context = buildAreaArtifactContext(home, Date.now(), pulseContext, evidenceIndex);
  const revision = areaArtifactRevision(context);
  if (
    !input.force &&
    home.livingBrief?.status === 'ready' &&
    (home.livingBrief?.pulse || home.livingBrief?.document || home.livingBrief?.artifactHtml) &&
    home.livingBrief?.basedOnRevision === revision
  ) {
    return home.livingBrief;
  }

  const areaName = String(home.area?.name || 'Area');
  const previous = fallbackAreaPulse(context);
  await areaLivingBriefDependencies.convexMutation((api as any).albatrossWorkV2.saveAreaBrief, {
    userId: input.userId,
    areaId: input.areaId,
    status: 'generating',
    lede: home.livingBrief?.lede || previous.lastChange || previous.prose,
    summary: home.livingBrief?.summary || previous.prose,
    sourceRefs: [],
    basedOnRevision: revision,
  });

  try {
    const pulse = await writeAreaPulse(context, input);
    const document = composeAreaPulseDocument(context, pulse);
    const artifactHtml = renderAreaPulseHtml(areaName, pulse);
    const lede = pulse.lastChange || pulse.nextMove || pulse.prose;
    await areaLivingBriefDependencies.convexMutation((api as any).albatrossWorkV2.saveAreaBrief, {
      userId: input.userId,
      areaId: input.areaId,
      status: 'ready',
      lede,
      summary: pulse.prose,
      document,
      artifactSource: 'document-v2',
      artifactHtml,
      sourceRefs: [],
      basedOnRevision: revision,
    });
    await areaLivingBriefDependencies.convexMutation((api as any).albatrossAreaPulse.saveAreaPulse, {
      userId: input.userId,
      areaId: input.areaId,
      pulse,
    });
    return {
      lede,
      summary: pulse.prose,
      pulse,
      document,
      artifactSource: 'document-v2',
      artifactHtml,
      status: 'ready',
      basedOnRevision: revision,
    };
  } catch (error) {
    await areaLivingBriefDependencies
      .convexMutation((api as any).albatrossWorkV2.saveAreaBrief, {
        userId: input.userId,
        areaId: input.areaId,
        status: 'error',
        lede: home.livingBrief?.lede || previous.prose,
        summary: home.livingBrief?.summary || previous.prose,
        sourceRefs: [],
        basedOnRevision: revision,
        error: error instanceof Error ? error.message : String(error),
      })
      .catch(() => undefined);
    throw error;
  }
}
