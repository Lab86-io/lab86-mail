import { randomUUID } from 'node:crypto';
import { describeProvider } from '../ai/client';
import { contextFirstName, getAiRequestContext } from '../ai/context';
import { generateTextForCurrentUser, resolveAiRuntime } from '../ai/gateway';
import { listNylasAccounts } from '../nylas/provider';
import {
  BRIEF_COMPOSITION_VERSION,
  type BriefComposition,
  compositionFromReport,
  extractBriefCompositionJson,
  parseBriefComposition,
} from '../shared/brief-composition';
import { emailFromHeader } from '../shared/format';
import {
  type DailyReport,
  type DailyReportArtifactError,
  type DailyReportArtifactErrorStage,
  type DailyReportCalendarItem,
  type DailyReportItem,
  type DailyReportTaskItem,
  MAX_ARTIFACT_ERROR_MESSAGE_CHARS,
  MAX_ARTIFACT_ERRORS,
  type Message,
} from '../shared/types';
import { getDailyReport, saveDailyReport } from '../store/daily-reports';
import { getThreadMessages } from '../store/messages';
import { briefServiceFromProvider, briefServicesFromIds } from './brief-services';
import { getDailyArt } from './daily-art';
import { generateDailyReport } from './daily-report';
import { buildNativeDailyReportArtifact } from './report-artifact';

// The agent-authored Daily Report.
//
// Vision: the model is handed the full, already-grounded report data (mail
// lanes, tasks, calendar, stats, narrative seed) plus a design brief and an
// interaction contract, and it authors typed BriefComposition JSON. The app's
// renderer owns all page chrome, typography, footer branding, action wiring,
// and sandboxing. The model can still request richer blocks (charts, timelines,
// checklists, or sandboxed custom widgets) when the data earns it.
//
// Two phases so the page never sits blank:
//   1. generateDailyReport() produces the structured edition, then we attach a
//      deterministic artifact from a default composition immediately.
//   2. the agent tries to replace that composition with a richer one, then the
//      month pass updates the same _id in place.

const MAX_TASKS = 32;
const MAX_EVENTS = 32;
const MAX_DIGEST_THREADS = 20;
const MAX_MSGS_PER_THREAD = 6;
const MAX_BODY_CHARS = 1100;
const MAX_VOICE_SAMPLES = 6;
const MAX_VOICE_CHARS = 600;

interface ThreadDigest {
  threadKey: string;
  account: string;
  threadId: string;
  subject: string;
  people: string[];
  unread: boolean;
  lastReceivedAt: number | null;
  trackedThreadId?: string;
  lane?: string;
  // The app's own grounding analysis, handed to the agent as a starting point
  // (it can override with its own read) rather than thrown away.
  whyItMatters?: string;
  nextAction?: string;
  openLoops?: string[];
  dueAt?: number | null;
  surfacedBecause?: string[];
  isNewSender?: boolean;
  messages: Array<{ from: string; date: number | null; body: string }>;
}

interface BriefExtras {
  digests: ThreadDigest[];
  voiceSamples: string[];
  services: string[];
}

function cleanBody(message: Message): string {
  const raw = message.textBody || message.snippet || '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_BODY_CHARS);
}

// Pulls the ACTUAL message bodies for the action-worthy threads (plus the
// user's own outbound prose as a voice sample) so the agent analyzes real
// content rather than pre-canned one-liners. Bounded for token cost.
export async function gatherBriefExtras(report: DailyReport, userId?: string | null): Promise<BriefExtras> {
  const accounts = userId ? await listNylasAccounts(userId).catch(() => []) : [];
  const self = new Set(
    accounts
      .filter((a) => a.authed)
      .map((a) => String(a.email || '').toLowerCase())
      .filter(Boolean),
  );

  const s = report.sections;
  const candidates: DailyReportItem[] = [
    ...(s.replyOwed ?? []),
    ...(s.followUpOwed ?? []),
    ...(s.timeSensitive ?? []),
    ...(s.newPeople ?? []),
    ...(s.tracked ?? []),
  ];
  const seen = new Set<string>();
  const digests: ThreadDigest[] = [];
  const voiceSamples: string[] = [];

  for (const item of candidates) {
    if (digests.length >= MAX_DIGEST_THREADS) break;
    const key = `${item.account}:${item.threadId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let messages: Message[] = [];
    try {
      messages = await getThreadMessages(item.account, item.threadId);
    } catch {
      messages = [];
    }
    // getThreadMessages isn't guaranteed ordered — sort oldest→newest so the
    // "recent" slice is actually the latest messages.
    messages.sort((a, b) => Number(a.date || 0) - Number(b.date || 0));
    const recent = messages.slice(-MAX_MSGS_PER_THREAD);
    const digestMessages = recent
      .map((m) => ({ from: m.from, date: m.date ?? null, body: cleanBody(m) }))
      .filter((m) => m.body.length > 0);
    if (!digestMessages.length) continue;
    digests.push({
      threadKey: JSON.stringify([item.account, item.threadId]),
      account: item.account,
      threadId: item.threadId,
      subject: item.subject,
      people: item.people,
      unread: item.unread,
      lastReceivedAt: item.receivedAt ?? null,
      trackedThreadId: item.trackedThreadId,
      lane: item.lane,
      whyItMatters: item.whyItMatters,
      nextAction: item.nextAction,
      openLoops: item.openLoops,
      dueAt: item.dueAt ?? null,
      surfacedBecause: item.surfacedBecause,
      isNewSender: item.isNewSender,
      messages: digestMessages,
    });
    // The user's own replies, as voice samples for matching tone in drafts.
    for (const m of recent) {
      if (voiceSamples.length >= MAX_VOICE_SAMPLES) break;
      const from = emailFromHeader(m.from) || '';
      if (from && self.has(from.toLowerCase())) {
        const body = (m.textBody || m.snippet || '').replace(/\s+/g, ' ').trim().slice(0, MAX_VOICE_CHARS);
        if (body.length > 40) voiceSamples.push(body);
      }
    }
  }

  const selectedAccounts = new Set((report.accounts ?? []).map((value) => String(value).toLowerCase()));
  const services = [
    ...new Set(
      accounts
        .filter(
          (account) =>
            account.authed &&
            (!selectedAccounts.size ||
              selectedAccounts.has(String(account.accountId || '').toLowerCase()) ||
              selectedAccounts.has(String(account.email || '').toLowerCase())),
        )
        .map((account) => briefServiceFromProvider(account.provider)),
    ),
  ];
  if ((s.calendar ?? []).length) services.push('calendar');
  if ((s.tasks ?? []).length) services.push('tasks');
  if (!services.length) services.push('mail');

  return { digests, voiceSamples, services };
}

function artifactError(stage: DailyReportArtifactErrorStage, err: unknown): DailyReportArtifactError {
  return { stage, message: artifactErrorText(err), at: Date.now() };
}

function artifactErrorText(err: unknown): string {
  const limit = (text: string) => text.slice(0, MAX_ARTIFACT_ERROR_MESSAGE_CHARS);
  const anyErr = err as any;
  if (Array.isArray(anyErr?.issues)) {
    const issues = anyErr.issues
      .slice(0, 8)
      .map((issue: any) => {
        const path = Array.isArray(issue.path) && issue.path.length ? issue.path.join('.') : 'composition';
        return `${path}: ${issue.message || 'invalid value'}`;
      })
      .join('; ');
    return limit(`Composition schema validation failed: ${issues}`);
  }
  if (err instanceof SyntaxError) return limit(`Composition JSON parse failed: ${err.message}`);
  if (err instanceof Error && err.message) return limit(err.message);
  if (typeof err === 'string' && err.trim()) return limit(err.trim());
  try {
    const text = JSON.stringify(err);
    if (text && text !== '{}') return limit(text);
  } catch {
    // ignored
  }
  return 'Unknown artifact generation failure.';
}

function withArtifactError(report: DailyReport, error: DailyReportArtifactError): DailyReport {
  return {
    ...report,
    artifactErrors: [...(report.artifactErrors || []), error].slice(-MAX_ARTIFACT_ERRORS),
  };
}

export function settleMonthArtifactReport(input: {
  full: DailyReport;
  phase1: DailyReport;
  composition: BriefComposition | null;
  failure?: DailyReportArtifactError;
}): DailyReport {
  const { full, phase1, composition, failure } = input;
  if (composition) {
    return {
      ...full,
      composition,
      html: buildNativeDailyReportArtifact(full, composition),
      artifactStatus: 'rendered',
      artifactSource: 'ai',
      artifactErrors: phase1.artifactErrors,
      model: describeProvider().primary || full.model,
    };
  }

  if (phase1.artifactSource === 'ai') {
    const settled: DailyReport = {
      ...phase1,
      artifactStatus: 'rendered',
      artifactSource: 'ai',
    };
    return failure ? withArtifactError(settled, failure) : settled;
  }

  const nativeFullComposition = compositionFromReport(full);
  const fallback: DailyReport = {
    ...full,
    composition: nativeFullComposition,
    html: buildNativeDailyReportArtifact(full, nativeFullComposition),
    artifactStatus: 'rendered',
    artifactSource: 'deterministic',
    artifactErrors: phase1.artifactErrors,
  };
  return failure ? withArtifactError(fallback, failure) : fallback;
}

export async function generateAgentReport(input: {
  kind: DailyReport['kind'];
  userId?: string | null;
  now?: number;
  reportId?: string;
}): Promise<DailyReport> {
  // Both passes share one edition id so the month pass overwrites the week one.
  const reportId = input.reportId ?? randomUUID();

  // Phase 1 — fast week pass. Streams progress and persists the structured
  // week edition so the page has something rich to show almost immediately.
  let week: DailyReport;
  try {
    week = await generateDailyReport({
      kind: input.kind,
      includeCalendar: true,
      userId: input.userId,
      now: input.now,
      scope: 'week',
      reportId,
    });
  } catch (err) {
    // The week pass persists a 'partial' edition before the work that can throw.
    // If it dies here, settle that edition terminal so the UI doesn't stay stuck
    // on a dead run (which would keep the Generate button disabled).
    console.error('[agent-report] week pass failed:', err);
    const partial = await getDailyReport(reportId).catch(() => null);
    if (partial) {
      await saveDailyReport({ ...partial, status: 'ready', artifactStatus: 'rendered' }).catch(
        () => undefined,
      );
    }
    throw err;
  }

  const nativeWeekComposition = compositionFromReport(week);
  const nativeWeekHtml = buildNativeDailyReportArtifact(week, nativeWeekComposition);

  // No model -> still save the deterministic artifact, but persist the exact
  // availability error so the UI can tell the user what blocked the artifact.
  try {
    await resolveAiRuntime({
      userId: input.userId,
      speed: 'primary',
      feature: 'daily_report_artifact',
    });
  } catch (err) {
    const nativeOnly = withArtifactError(
      {
        ...week,
        composition: nativeWeekComposition,
        html: nativeWeekHtml,
        artifactStatus: 'rendered',
        artifactSource: 'deterministic',
      },
      artifactError('ai_availability', err),
    );
    await saveDailyReport(nativeOnly).catch(() => undefined);
    return nativeOnly;
  }

  await saveDailyReport({
    ...week,
    composition: nativeWeekComposition,
    html: nativeWeekHtml,
    artifactStatus: 'composing',
    artifactSource: 'deterministic',
  }).catch(() => undefined);

  let phase1: DailyReport;
  try {
    const composition = await composeComposition(week, input.userId);
    // 'enriching' (not 'rendered') keeps the page polling for the month pass.
    phase1 = {
      ...week,
      composition,
      html: buildNativeDailyReportArtifact(week, composition),
      artifactStatus: 'enriching',
      artifactSource: 'ai',
      model: describeProvider().primary || week.model,
    };
  } catch (err) {
    console.error('[agent-report] week artifact failed:', err);
    phase1 = withArtifactError(
      {
        ...week,
        composition: nativeWeekComposition,
        html: nativeWeekHtml,
        artifactStatus: 'enriching',
        artifactSource: 'deterministic',
      },
      artifactError('week_artifact', err),
    );
  }
  await saveDailyReport(phase1).catch(() => undefined);

  // Phase 2 — broaden to the full month silently, then replace the edition in
  // place. Best-effort: if it fails (e.g. out of credits), keep the week brief.
  let finalReport: DailyReport;
  try {
    const full = await generateDailyReport({
      kind: input.kind,
      includeCalendar: true,
      userId: input.userId,
      now: input.now,
      scope: 'full',
      reportId,
      silent: true,
    });
    let composition: BriefComposition | null = null;
    let failure: DailyReportArtifactError | undefined;
    try {
      composition = await composeComposition(full, input.userId);
    } catch (err) {
      console.error('[agent-report] month artifact failed:', err);
      failure = artifactError('month_artifact', err);
    }
    finalReport = settleMonthArtifactReport({ full, phase1, composition, failure });
  } catch (err) {
    console.error('[agent-report] month enrichment failed:', err);
    // Settle on the week edition so the page stops polling.
    const settled = withArtifactError(
      { ...phase1, artifactStatus: 'rendered' },
      artifactError('month_enrichment', err),
    );
    try {
      await saveDailyReport(settled);
    } catch (saveErr) {
      console.error('[agent-report] month enrichment fallback save failed:', saveErr);
      throw saveErr;
    }
    return settled;
  }

  try {
    await saveDailyReport(finalReport);
  } catch (err) {
    console.error('[agent-report] month report save failed:', err);
    throw err;
  }

  return finalReport;
}

// ---- Artifact composition --------------------------------------------------

async function composeComposition(report: DailyReport, userId?: string | null): Promise<BriefComposition> {
  const extras = await gatherBriefExtras(report, userId);
  const { text } = await generateTextForCurrentUser({
    feature: 'daily_report_artifact', // tiered cap → 32k output
    speed: 'primary',
    system: COMPOSITION_BRIEF,
    prompt: buildDataPrompt(report, extras),
  });
  return parseBriefComposition(extractBriefCompositionJson(text));
}

// ---- Prompts ---------------------------------------------------------------

const COMPOSITION_BRIEF = `You are the user's chief of staff and an expert information designer. You are handed the RAW material — actual email bodies, the calendar, tasks, and connected tool items — and you do your own analysis. Return ONLY typed JSON for a Lab86 Daily Brief composition. The application renders the HTML, typography, footer, logos, action wiring, and sandboxing.

ANALYZE, DON'T TRANSCRIBE:
- Read the email bodies in data.threads and decide for yourself what matters and why — do not parrot subjects. Form a real point of view. Each thread also carries the app's own first-pass read (whyItMatters, nextAction, openLoops, surfacedBecause, isNewSender) — treat it as a STARTING POINT you can sharpen or overrule with what you find in the bodies, never as text to copy verbatim.
- Build an INTEGRATED STORY: weave what needs the user now (recent mail) with what's coming (next 7 days of calendar + due tasks), drawing explicit connections ("Thu review with Sam ↔ his unanswered Tuesday thread ↔ prep task"). Use the richer fields you're given — task descriptions/labels/assignees, event descriptions/locations — to make those connections concrete.
- Be PROACTIVE, and you have real levers — propose AND wire them: to-dos (create_task), ready-to-send reply drafts in the user's voice (draft_reply), calendar holds for focus/prep/buffer (create_event), invite responses (rsvp_event), and clearing obvious noise (archive_thread). Nothing executes without a tap, so lean toward offering the action rather than just naming it.
- YOU HAVE FULL EDITORIAL CONTROL. Beyond the sections below, add whatever you judge genuinely useful for THIS person today and omit what isn't — e.g. a "Focus blocks" suggestion that proposes create_event holds around deep work, a "Waiting on others" list, a tight "Clear the noise" row of archivable FYIs, or a prep dossier for the day's most important meeting. Go deeper where it earns its space; stay calm and short on a light day. Never pad.
- Adaptive density: short and calm on a light day, fuller when it's busy. Never pad.
- DESIGN THE BRIEF, DON'T JUST SUMMARIZE. The rendered output should feel like an editorial artifact: lead with 2-3 short lede paragraphs when there is enough material, surface concrete decisions and next actions, and use charts/timelines/prep checklists/custom_widget when the shape of the day benefits from a visual or interactable view. If a specific visualization or tiny workflow would make the brief clearer, create it as a custom_widget with fallbackMarkdown.

OUTPUT RULES (critical):
- Output ONLY JSON. No markdown fences, no commentary.
- Top-level shape: { "version": ${BRIEF_COMPOSITION_VERSION}, "title": string, "summary"?: string, "services": string[], "blocks": BriefBlock[] }.
- Use real ids/accounts from the data only. Never invent ids.
- Every rich/generated claim outside a simple lede must include sourceRefs pointing to the source thread/message/task/event/mcp item. Charts and custom widgets require sourceRefs.

DO NOT:
- Do NOT render a stat strip or counter tiles ("X scanned", "Y reply owed", "Z events"). Raw counts are noise — omit them entirely.
- Do NOT include page chrome, masthead, footer/signoff, source footer, logo SVG, global CSS, or JavaScript for standard actions. The renderer owns those.
- Do NOT use a custom_widget when a standard block can express the idea.

VALID BLOCKS:
- lede: { type:"lede", title?, paragraphs:[string], sourceRefs? }. Use 2-3 short paragraphs when there is enough substance, otherwise 1. Make it narrative and specific, not a generic summary. No emoji.
- needs_you: { type:"needs_you", title?, items:[{ account, threadId, subject, person, reason, lane?, receivedAt?, trackedThreadId?, draftReply?, sourceRefs, actions? }], sourceRefs? }. Include only threads you judge action-worthy.
- task_digest: { type:"task_digest", title?, tasks:[{ cardId, title, meta?, dueAt?, sourceRefs, actions? }], sourceRefs? }. Existing tasks only.
- week_ahead: { type:"week_ahead", title?, events:[{ account, eventId, calendarId?, title, startAt, endAt, allDay?, location?, prep?, sourceRefs, actions? }], sourceRefs? }.
- tool_digest: { type:"tool_digest", title?, items:[{ server:"github"|"bitbucket"|"jira"|"slack", title, state?, author?, url?, reason?, sourceRefs, actions? }], sourceRefs? }. Never call this "MCP".
- chart: { type:"chart", variant:"bar"|"stacked_bar"|"donut", title, description?, data:[{ label, value, group? }], sourceRefs }. Use for meaningful comparisons/trends, not vanity counts.
- timeline: { type:"timeline", title, items:[{ label, at?, detail?, sourceRefs? }], sourceRefs? }. Use for sequences/deadlines.
- prep_checklist: { type:"prep_checklist", title, items:[{ label, detail?, sourceRefs?, action? }], sourceRefs? }. Use for meeting/project prep.
- custom_widget: { type:"custom_widget", id, title, html, fallbackMarkdown, allowedActions, sourceRefs }. Use when the brief needs an interactable widget or visualization the standard blocks cannot express.

VALID ACTIONS:
- open_thread { account, threadId }
- open_view { view:"mail"|"tasks"|"calendar" }
- open_event { account, eventId }
- resolve_thread { account, threadId, subject?, receivedAt?, trackedThreadId? }
- dismiss_thread { account, threadId, subject?, receivedAt? }
- toggle_task { cardId, completed, title? }
- dismiss_task { cardId, title? }
- create_task { title, dueAt? }
- draft_reply { account, threadId, body }
- archive_thread { account, threadId, subject?, receivedAt? }
- rsvp_event { account, calendarId, eventId, status:"yes"|"no"|"maybe" }
- create_event { account, title, startAt, endAt, location?, description? }

CUSTOM WIDGET RULES:
- html is placed inside a nested sandboxed iframe. No external resources, fetch, XMLHttpRequest, WebSocket, EventSource, storage, cookies, nested iframes, or remote src/href.
- Keep HTML/CSS/JS self-contained and compact.
- To request host actions, post: window.parent.postMessage({ source:"lab86-brief-widget", action, payload }, "*"). The action must appear in allowedActions and be one of VALID ACTIONS.
- Always provide fallbackMarkdown that preserves the insight if the widget is rejected.`;

// The shapes handed to the agent for each task/event. Pure + exported so the
// field mapping (everything the brief gets to act on) is unit-tested directly.
export function toBriefTask(t: DailyReportTaskItem) {
  return {
    cardId: t.cardId,
    boardTitle: t.boardTitle,
    columnName: t.columnName,
    title: t.title,
    description: t.description ?? null,
    dueAt: t.dueAt ?? null,
    priority: t.priority,
    labels: t.labels ?? [],
    assignees: t.assignees ?? [],
    completed: false,
    sourceUrl: t.sourceUrl ?? null,
    sourceTitle: t.sourceTitle ?? null,
  };
}

export function toBriefEvent(e: DailyReportCalendarItem) {
  return {
    account: e.account,
    eventId: e.eventId,
    calendarId: e.calendarId ?? null,
    calendarName: e.calendarName ?? null,
    title: e.title,
    startAt: e.startAt,
    endAt: e.endAt,
    allDay: e.allDay ?? false,
    location: e.location ?? null,
    description: e.description ?? null,
    htmlLink: e.htmlLink ?? null,
  };
}

export function buildDataPrompt(report: DailyReport, extras: BriefExtras): string {
  const s = report.sections;
  const tasks = (s.tasks ?? [])
    .filter((t: DailyReportTaskItem) => !t.completedAt)
    .slice(0, MAX_TASKS)
    .map(toBriefTask);
  const calendar = (s.calendar ?? []).slice(0, MAX_EVENTS).map(toBriefEvent);

  // Format the dateline in the USER's timezone (set on the request context) so
  // the masthead shows their local day/time, not the server's UTC clock.
  const timeZone = getAiRequestContext().userTimezone || 'UTC';
  const at = new Date(report.generatedAt);
  const fmt = (opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('en-US', { timeZone, ...opts }).format(at);
  const weekday = fmt({ weekday: 'long' });
  const localDate = fmt({ day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();
  const localTime = fmt({ hour: 'numeric', minute: '2-digit' });
  const art = getDailyArt(report.generatedAt);

  const serviceIds = [
    ...(report.services || []),
    ...extras.services,
    ...[...new Set((report.sections.mcp ?? []).map((m) => m.server))],
  ];

  const data = {
    weekday,
    localDate,
    localTime,
    timezone: timeZone,
    kind: report.kind,
    art,
    firstName: contextFirstName() || null,
    services: briefServicesFromIds(serviceIds),
    // The user's own recent outbound prose — match this voice in any draft.
    voiceSamples: extras.voiceSamples,
    // RAW material to analyze yourself: real thread bodies (most recent last).
    threads: extras.digests,
    tasks,
    calendar,
    // Items from connected tools the user enabled for the
    // brief: open issues, PRs awaiting review, assigned tickets, mentions.
    mcp: (report.sections.mcp ?? []).slice(0, 20),
  };

  return [
    `It is ${data.weekday}, ${data.localDate}, ${data.localTime} (${data.timezone}) for ${data.firstName || 'the user'}.`,
    `This is the "${report.kind}" edition.`,
    'Read data.threads (real email bodies), the calendar, tasks, and connected tool items. Do your own analysis and return the Daily Brief composition JSON. Every id/account is real; use them verbatim and never fabricate ids.',
    '',
    '```json',
    JSON.stringify(data, null, 2),
    '```',
  ].join('\n');
}
