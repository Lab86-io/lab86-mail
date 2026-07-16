import { createHash } from 'node:crypto';
import { generateTextForCurrentUser } from '../ai/gateway';
import { api, convexMutation, convexQuery } from '../hosted/convex';
import { withDeadline } from '../shared/deadline';
import { injectAreaArtifactFontContract } from './area-artifact-fonts';

const AREA_ARTIFACT_DEADLINE_MS = 180_000;

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

export function extractAreaArtifactHtml(raw: string): string | null {
  let text = String(raw || '').trim();
  const fence = text.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.search(/<!doctype html|<html[\s>]/i);
  if (start === -1) return null;
  text = text.slice(start);
  const end = text.toLowerCase().lastIndexOf('</html>');
  if (end === -1) return null;
  text = text.slice(0, end + 7).trim();
  return text.length >= 200 ? text : null;
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

export const AREA_ARTIFACT_SYSTEM = `You are the user's chief of staff and a world-class editorial designer/front-end engineer. Compose one complete, self-contained HTML Area Brief from the supplied JSON.

THIS DOCUMENT IS THE AREA SCREEN. It is not a widget inside a dashboard. Be creative. Treat the whole page as a canvas. Invent a visual grammar for THIS Area and THIS edition. Its structure should legitimately change with the Area's content and operating shape. Do not output a generic dashboard, admin page, card grid, or templated status report.

PRODUCT TRUTH:
- Albatross is an intent layer. Declared Work and what the user explicitly said they are trying to do outrank the volume of mail, events, or tasks.
- Projects/Epics are durable multi-week containers grouping tasks and Work. A plan is nested under the Work it implements; never create a standalone Plans destination or Plans section.
- Evidence can support a read but cannot prove intent or completion. Never say work is done unless an explicit completed/completedAt state says so. Never infer completion from email silence or activity.
- livingIndex.strength is bounded corroboration, not a completion score or probability. Use it only to explain how well-grounded the Area model is. More repeated evidence should make the read more confident, never louder or falsely certain.
- projectPulse is the live layer for Projects/Epics and routines. A proposed routine is not active consent. Make recurring work and its next useful question visible without turning the page into a habit tracker.
- context.verified may be stated as fact. context.candidates are uncertain hypotheses: phrase them as a quiet question with "Suggested" provenance, or omit them.
- Use only supplied data. Never invent importance, progress, people, commitments, deadlines, dependencies, quotations, or metrics.

COMPOSITION:
- Analyze and synthesize; do not mechanically transcribe the JSON keys into sections.
- Answer through the composition: what this Area is, what matters now, what needs the user, what is moving, which Project/Epic owns longer-running work, and what evidence supports the read.
- Omit empty ideas. A noisy mailbox must not dominate merely because it has more rows.
- Build from real relationships: time, momentum, waiting, decisions, project nesting, and provenance. Use typography, rhythm, annotation, spatial grouping, responsive CSS, and restrained inline SVG where they genuinely explain real data.
- When enough data exists, make at least one module memorable by form: perhaps a week rail, operating map, project constellation, decision ledger, momentum field, or annotated dossier. Those are inspiration, not a template. Never draw a decorative chart from meaningless numbers.
- Integrate a compact "Get this out of my head" form when appropriate: a form with data-area-capture, one input/textarea carrying data-capture-input, and a submit control with data-action="capture_intent" and data-payload containing only {"areaId":"the supplied areaId"}. The host runtime supplies the typed text.
- When projectPulse contains a pending question, the page may ask ONE highest-value question in context. Use a compact form with data-area-question and data-question-id="the supplied questionId", one input, textarea, or select carrying data-question-input, and a submit control with data-action="answer_question" and data-payload containing only {"questionId":"the supplied questionId"}. Use supplied options when finite. Never repeat the same question elsewhere in the document.
- Reserve breathing room near the top corners for small floating host controls; do not draw app navigation, a toolbar, a sidebar, refresh controls, or settings inside the document.

ANTI-SLOP CHECK:
- No generic hero/subtitle/CTA formula, purple/blue SaaS gradients, glow blobs, glassmorphism, equal feature cards, counter/stat tiles, repeated bordered rectangles, icon/emoji decoration, fake metrics, generic headings, or a layout that would still make sense if a different Area's content were swapped in.
- No assistant greeting, hype, exclamation marks, productivity advice, or first-person assistant voice.
- Do not use ALL-CAPS letter-spaced micro-labels. Headings use sentence case.

THEME AND ACCESSIBILITY:
- Use semantic variables everywhere: --brief-bg (#faf9f6), --brief-ink (#1a1a1a), --brief-muted (#6b6b6b), --brief-hairline (#e6e3dc), --brief-accent (#276749), --brief-accent-soft (color-mix(in oklab,var(--brief-accent) 14%,transparent)), --brief-accent-2 (#8a4b20), --brief-font-display ('Fraunces',Georgia,serif), --brief-font-body ('Geist',system-ui,sans-serif), --brief-display-tracking (0em).
- Include usable light :root fallbacks and @media(prefers-color-scheme:dark) that remaps only --brief-* tokens. The host posts live tokens later.
- The host loads the approved fonts. Never hardcode a font-family. Use --brief-font-body for all body/UI copy and --brief-font-display for every heading or editorial display line; mark non-heading display text with data-brief-display so the live app font is enforced. The user's selected display face may change after this document is generated.
- No external resources.
- Responsive from 360px to 1200px; generous wide-pane composition without making mobile a shrunken desktop. Visible :focus-visible, semantic headings, real buttons/links for actions, and reduced-motion support are required.
- Use tasteful entrance motion only when it clarifies hierarchy; honor prefers-reduced-motion.

ACTIONS:
- The host runtime is injected after generation. You only declare data-action and JSON data-payload attributes. Do not write any JavaScript.
- open_work payload {"workId":"..."}
- open_thread payload {"accountId":"...","threadId":"..."}
- open_event payload {"accountId":"...","eventId":"..."}
- open_tasks payload {}
- discuss_area payload {"areaId":"..."}
- capture_intent as described above. Never put invented or prefilled text in this action.
- answer_question as described above. Use only a supplied pending questionId. The host supplies the typed or selected answer.
- Use only IDs supplied in the corresponding records. Do not create actions when the ID is null.

OUTPUT:
- One complete <!doctype html> document, under 900 lines, with all CSS in one <style>. No JavaScript, iframe, object, embed, external image, app chrome, or prose outside the document.
- Body fills the full pane edge-to-edge; use internal responsive padding. The host toolbar floats above it.
- End with one quiet source note stating that the edition is composed from this Area's declared Work and linked evidence, with uncertain context labeled rather than asserted.
- Output only the HTML document.`;

function fallbackCopy(home: AreaHomeLike) {
  const work = home.plans?.length || 0;
  const projects = home.projects?.length || 0;
  const name = clean(home.area?.name, 180) || 'This area';
  return {
    lede: `${name} has ${work} active Work item${work === 1 ? '' : 's'} and ${projects} Project${projects === 1 ? '' : 's'}.`,
    summary:
      'The Area artifact is composed from declared Work, Projects, tasks, calendar, mail, and verified context.',
  };
}

export async function generateAreaLivingBrief(input: {
  userId: string;
  userEmail?: string | null;
  userName?: string | null;
  areaId: string;
  force?: boolean;
}) {
  const [home, pulse, evidenceIndex] = await Promise.all([
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
  const context = buildAreaArtifactContext(home, Date.now(), pulse, evidenceIndex);
  const revision = areaArtifactRevision(context);
  if (
    !input.force &&
    home.livingBrief?.status === 'ready' &&
    home.livingBrief?.artifactHtml &&
    home.livingBrief?.basedOnRevision === revision
  ) {
    return home.livingBrief;
  }

  const fallback = fallbackCopy(home);
  await areaLivingBriefDependencies.convexMutation((api as any).albatrossWorkV2.saveAreaBrief, {
    userId: input.userId,
    areaId: input.areaId,
    status: 'generating',
    lede: home.livingBrief?.lede || fallback.lede,
    summary: home.livingBrief?.summary || fallback.summary,
    sourceRefs: [],
    basedOnRevision: revision,
  });

  try {
    const { text } = await withDeadline(
      areaLivingBriefDependencies.generateTextForCurrentUser({
        feature: 'albatross_area_artifact',
        speed: 'primary',
        userId: input.userId,
        userEmail: input.userEmail,
        userName: input.userName,
        system: AREA_ARTIFACT_SYSTEM,
        prompt: JSON.stringify(context, null, 2),
      }),
      AREA_ARTIFACT_DEADLINE_MS,
      'Area artifact composition',
    );
    const extracted = extractAreaArtifactHtml(text);
    if (!extracted) throw new Error('AI did not return a complete Area HTML document.');
    const artifactHtml = normalizeAreaArtifactHtml(extracted);
    await areaLivingBriefDependencies.convexMutation((api as any).albatrossWorkV2.saveAreaBrief, {
      userId: input.userId,
      areaId: input.areaId,
      status: 'ready',
      ...fallback,
      artifactHtml,
      sourceRefs: [],
      basedOnRevision: revision,
    });
    return { ...fallback, artifactHtml, status: 'ready', basedOnRevision: revision };
  } catch (error) {
    await areaLivingBriefDependencies
      .convexMutation((api as any).albatrossWorkV2.saveAreaBrief, {
        userId: input.userId,
        areaId: input.areaId,
        status: 'error',
        lede: home.livingBrief?.lede || fallback.lede,
        summary: home.livingBrief?.summary || fallback.summary,
        sourceRefs: [],
        basedOnRevision: revision,
        error: error instanceof Error ? error.message : String(error),
      })
      .catch(() => undefined);
    throw error;
  }
}
