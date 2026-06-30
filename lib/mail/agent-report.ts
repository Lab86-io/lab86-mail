import { randomUUID } from 'node:crypto';
import { describeProvider } from '../ai/client';
import { contextFirstName, getAiRequestContext } from '../ai/context';
import { generateTextForCurrentUser, resolveAiRuntime } from '../ai/gateway';
import { listNylasAccounts } from '../nylas/provider';
import { type BriefComposition, compositionFromReport } from '../shared/brief-composition';
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
// interaction contract, and it authors a single self-contained HTML artifact.
// The app owns sandboxing, theme injection, and the action bridge; the model
// owns the editorial layout and component design.
//
// Two phases so the page never sits blank:
//   1. generateDailyReport() produces the structured edition, then we attach a
//      deterministic artifact immediately so the page never goes blank.
//   2. the agent replaces it with full HTML, then the month pass updates the
//      same _id in place. The deterministic composition remains the fallback.

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

export function settleMonthHtmlArtifactReport(input: {
  full: DailyReport;
  phase1: DailyReport;
  html: string | null;
  failure?: DailyReportArtifactError;
}): DailyReport {
  const { full, phase1, html, failure } = input;
  if (html) {
    const settled: DailyReport = {
      ...full,
      html,
      artifactStatus: 'rendered',
      artifactSource: 'ai',
      artifactErrors: phase1.artifactErrors,
      model: describeProvider().primary || full.model,
    };
    delete (settled as any).composition;
    return settled;
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
    try {
      await saveDailyReport(nativeOnly);
    } catch (saveErr) {
      console.error('[agent-report] AI availability fallback save failed:', saveErr);
      throw saveErr;
    }
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
    const html = await composeArtifactHtml(week, input.userId);
    // 'enriching' (not 'rendered') keeps the page polling for the month pass.
    phase1 = {
      ...week,
      html,
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
    let html: string | null = null;
    let failure: DailyReportArtifactError | undefined;
    try {
      html = await composeArtifactHtml(full, input.userId);
    } catch (err) {
      console.error('[agent-report] month artifact failed:', err);
      failure = artifactError('month_artifact', err);
    }
    finalReport = settleMonthHtmlArtifactReport({ full, phase1, html, failure });
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

async function composeArtifactHtml(report: DailyReport, userId?: string | null): Promise<string> {
  const extras = await gatherBriefExtras(report, userId);
  const { text } = await generateTextForCurrentUser({
    feature: 'daily_report_artifact', // tiered cap → 32k output
    speed: 'primary',
    userId,
    system: HTML_ARTIFACT_BRIEF,
    prompt: buildDataPrompt(report, extras),
  });
  const html = extractHtml(text);
  if (!html) throw new Error('AI did not return a complete HTML document.');
  return html;
}

export function extractHtml(raw: string): string | null {
  let text = (raw || '').trim();
  const fence = text.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.search(/<!doctype html|<html[\s>]/i);
  if (start === -1) return null;
  text = text.slice(start).trim();
  const end = text.toLowerCase().lastIndexOf('</html>');
  if (end === -1) return null;
  text = text.slice(0, end + '</html>'.length);
  return text.length > 200 ? text : null;
}

// ---- Prompts ---------------------------------------------------------------

const HTML_ARTIFACT_BRIEF = `You are the user's chief of staff, a world-class editorial designer, and a production front-end engineer. You are handed the RAW material — actual email bodies, the calendar, tasks, and connected tool items — and you do your own analysis. Return one complete, self-contained Lab86 Daily Brief HTML document. The app will sandbox it, inject live theme variables, and bridge actions to the host.

TWO MODES, BOTH REQUIRED:
- Backend contract mode: be exact, literal, and valid. Use only the ids, accounts, action enum strings, and payload shapes below. Never improvise backend keys, action names, ids, accounts, calendar ids, thread ids, task ids, or event ids.
- Design/composition mode: be creative inside that contract. You own the visual design, layout, hierarchy, components, charts, timelines, prep panels, and microinteractions. Make the result feel like a polished editorial artifact, not a generic list.

ANALYZE, DON'T TRANSCRIBE:
- Read the email bodies in data.threads and decide for yourself what matters and why — do not parrot subjects. Form a real point of view. Each thread also carries the app's own first-pass read (whyItMatters, nextAction, openLoops, surfacedBecause, isNewSender) — treat it as a STARTING POINT you can sharpen or overrule with what you find in the bodies, never as text to copy verbatim.
- Build an INTEGRATED STORY: weave what needs the user now (recent mail) with what's coming (next 7 days of calendar + due tasks), drawing explicit connections ("Thu review with Sam ↔ his unanswered Tuesday thread ↔ prep task"). Use the richer fields you're given — task descriptions/labels/assignees, event descriptions/locations — to make those connections concrete.
- Be PROACTIVE, and you have real levers — propose AND wire them: to-dos (create_task), ready-to-send reply drafts in the user's voice (draft_reply), calendar holds for focus/prep/buffer (create_event), invite responses only when the event has canRsvp:true (rsvp_event), and clearing obvious noise (archive_thread). Nothing executes without a user tap and host confirmation for mutations, so lean toward offering the action rather than just naming it.
- YOU HAVE FULL EDITORIAL CONTROL. Beyond the sections below, add whatever you judge genuinely useful for THIS person today and omit what isn't — e.g. a "Focus blocks" suggestion that proposes create_event holds around deep work, a "Waiting on others" list, a tight "Clear the noise" row of archivable FYIs, or a prep dossier for the day's most important meeting. Go deeper where it earns its space; stay calm and short on a light day. Never pad.
- Adaptive density: short and calm on a light day, fuller when it's busy. Never pad.
- DESIGN THE BRIEF, DON'T JUST SUMMARIZE. Lead with 2-3 short lede paragraphs when there is enough material, surface concrete decisions and next actions, and use charts/timelines/prep checklists/compact dashboards when the shape of the day benefits from visual structure.

OUTPUT RULES (critical):
- Output ONLY a complete HTML document, starting with <!doctype html>. No markdown fences, no commentary before or after.
- All CSS must be inside one <style> tag. JS is optional; if used, keep it inside one <script> tag.
- The ONLY permitted external resources are: data.art.imageUrl/fallback image URLs and the Google Fonts link shown below. No other network requests, remote scripts, fetch, XMLHttpRequest, WebSocket, EventSource, storage, cookies, or nested iframes.
- Use real ids/accounts from the data only. Never invent ids. If an item lacks the ids/accounts needed for an action, render it without that action.
- Action controls MUST be regular clickable elements with data-action and data-payload attributes. The host-injected runtime will postMessage for you. Do not invent action names.
- data-payload MUST be a valid JSON object string containing the exact ids/accounts for that action. Escape it correctly for HTML attributes. Prefer fewer buttons over guessed wiring.
- Before final output, mentally validate every button: data-action is one VALID ACTION, data-payload is JSON, and every payload id/account exists in the data.

THEME AND ASSETS:
- Define these CSS custom properties on :root WITH fallbacks, and use them everywhere:
  --brief-bg (#faf9f6), --brief-ink (#1a1a1a), --brief-muted (#6b6b6b), --brief-hairline (#e6e3dc),
  --brief-accent (#c2683c), --brief-accent-soft (color-mix(in oklab, var(--brief-accent) 14%, transparent)),
  --brief-font-display ('Fraunces', Georgia, serif), --brief-font-body ('Geist', system-ui, sans-serif), --brief-display-tracking (0em).
- Load fonts with exactly one Google Fonts link:
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400..700;1,9..144,400..600&family=Instrument+Serif:ital@0;1&family=Instrument+Sans:wght@400..700&family=Averia+Serif+Libre:wght@400;700&family=Geist:wght@400..700&family=Hanken+Grotesk:wght@400..700&display=swap">
- Include the daily art masthead using data.art.imageUrl, with data.art.fallbacks for image fallback if desired, and a small attribution using data.art.credit + " · " + data.art.source.
- The host will inject live theme variables after load. Include this listener if you use custom JS: window.addEventListener('message', (e) => { const d = e.data; if (d && d.source === 'lab86-host' && d.type === 'theme' && d.theme) { for (const k in d.theme) document.documentElement.style.setProperty(k, d.theme[k]); } });

DESIGN:
- Editorial, confident, generous whitespace. Clear typographic hierarchy. Fully responsive from 360px to wide desktop. Use grid/flex, inline SVG charts, and tasteful micro-animations.
- Avoid a generic stacked list. Use named sections, visual groupings, cards/tables/rails where useful, and compact dashboards for tool/calendar/task clusters.
- The design should work in light and dark because the host may override --brief-* variables. Do not hardcode large white panels that will clash with a dark host theme.

DO NOT:
- Do NOT render a stat strip or counter tiles ("X scanned", "Y reply owed", "Z events"). Raw counts are noise — omit them entirely.
- Do NOT include "With love from Lab86".
- Do NOT include a second app toolbar or app chrome.
- Do NOT write standard action JavaScript; use data-action/data-payload. JS is only for local UI polish such as filtering, disclosure, or optimistic visual states.
- Do NOT use action names outside VALID ACTIONS, including "reply", "open", "email", "schedule", "snooze", "complete", or "view". Pick the exact valid action name or omit the action.

VALID ACTIONS:
- open_thread payload { account, threadId }
- open_view payload { view:"mail"|"tasks"|"calendar" }
- open_event payload { account, eventId }
- resolve_thread payload { account, threadId, subject?, receivedAt?, trackedThreadId? }
- dismiss_thread payload { account, threadId, subject?, receivedAt? }
- toggle_task payload { cardId, completed, title? }
- dismiss_task payload { cardId, title? }
- create_task payload { title, dueAt? }
- draft_reply payload { account, threadId, body }
- archive_thread payload { account, threadId, subject?, receivedAt? }
- rsvp_event payload { account, calendarId, eventId, status:"yes"|"no"|"maybe" }. Only use when the event has canRsvp:true and a non-empty calendarId.
- create_event payload { account, title, startAt, endAt, allDay?, location?, description? }`;

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
    canRsvp: Boolean(e.calendarId),
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
    'Read data.threads (real email bodies), the calendar, tasks, and connected tool items. Do your own analysis and return the complete Daily Brief HTML document.',
    'Backend contract: use exact ids/accounts from this JSON verbatim. For action controls, use only valid data-action enum strings and valid data-payload JSON. Omit any action you cannot wire exactly.',
    'Design contract: be editorial and component-minded. Create the layout, visual comparisons, timelines, checklists, or compact dashboards that best fit the actual day.',
    '',
    '```json',
    JSON.stringify(data, null, 2),
    '```',
  ].join('\n');
}
