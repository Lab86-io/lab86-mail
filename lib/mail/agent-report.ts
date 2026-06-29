import { randomUUID } from 'node:crypto';
import { describeProvider } from '../ai/client';
import { contextFirstName, getAiRequestContext } from '../ai/context';
import { generateTextForCurrentUser, hasAiForCurrentUser } from '../ai/gateway';
import { listNylasAccounts } from '../nylas/provider';
import { emailFromHeader } from '../shared/format';
import type {
  DailyReport,
  DailyReportCalendarItem,
  DailyReportItem,
  DailyReportTaskItem,
  Message,
} from '../shared/types';
import { getDailyReport, saveDailyReport } from '../store/daily-reports';
import { getThreadMessages } from '../store/messages';
import { getDailyArt } from './daily-art';
import { generateDailyReport } from './daily-report';
import { buildNativeDailyReportArtifact } from './report-artifact';

// The agent-authored Daily Report.
//
// Vision: rather than a fixed React layout, the model is handed the full,
// already-grounded report data (mail lanes, tasks, calendar, stats, narrative
// seed) plus a design brief and an interaction contract, and it authors a
// single self-contained HTML document. The report page serves that document in
// a sandboxed iframe. The structured `DailyReport` still backs it — it is the
// grounding data, the history metadata, and the legacy fallback renderer.
//
// Two phases so the page never sits blank:
//   1. generateDailyReport() produces the structured edition, then we attach a
//      deterministic new-style HTML artifact immediately.
//   2. the agent tries to replace that native artifact with a richer designed
//      artifact, then the month pass updates the same _id in place.

const MAX_TASKS = 32;
const MAX_EVENTS = 32;
const MAX_DIGEST_THREADS = 20;
const MAX_MSGS_PER_THREAD = 6;
const MAX_BODY_CHARS = 1100;
const MAX_VOICE_SAMPLES = 6;
const MAX_VOICE_CHARS = 600;

const PROVIDER_LABEL: Record<string, string> = {
  google: 'Gmail',
  microsoft: 'Outlook',
  icloud: 'iCloud Mail',
  imap: 'Mail',
};

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
async function gatherBriefExtras(report: DailyReport, userId?: string | null): Promise<BriefExtras> {
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

  const mailLabels = [
    ...new Set(accounts.filter((a) => a.authed).map((a) => PROVIDER_LABEL[a.provider] || 'Mail')),
  ];
  const services = [...mailLabels];
  if ((s.calendar ?? []).length) services.push('Calendar');
  if ((s.tasks ?? []).length) services.push('Tasks');
  if (!services.length) services.push('mail');

  return { digests, voiceSamples, services };
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

  const nativeWeekHtml = buildNativeDailyReportArtifact(week);

  // No model -> still save the new-style HTML artifact. The legacy structured
  // renderer is no longer the scheduled-edition fallback.
  if (!(await hasAiForCurrentUser())) {
    const nativeOnly: DailyReport = { ...week, html: nativeWeekHtml, artifactStatus: 'rendered' };
    await saveDailyReport(nativeOnly).catch(() => undefined);
    return nativeOnly;
  }

  await saveDailyReport({ ...week, html: nativeWeekHtml, artifactStatus: 'composing' }).catch(
    () => undefined,
  );

  let phase1: DailyReport;
  try {
    const html = await composeArtifact(week, input.userId);
    // 'enriching' (not 'rendered') keeps the page polling for the month pass.
    phase1 = html
      ? { ...week, html, artifactStatus: 'enriching', model: describeProvider().primary || week.model }
      : { ...week, html: nativeWeekHtml, artifactStatus: 'enriching' };
  } catch (err) {
    console.error('[agent-report] week artifact failed:', err);
    phase1 = { ...week, html: nativeWeekHtml, artifactStatus: 'enriching' };
  }
  await saveDailyReport(phase1).catch(() => undefined);

  // Phase 2 — broaden to the full month silently, then replace the edition in
  // place. Best-effort: if it fails (e.g. out of credits), keep the week brief.
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
    const nativeFullHtml = buildNativeDailyReportArtifact(full);
    let html: string | null = null;
    try {
      html = await composeArtifact(full, input.userId);
    } catch (err) {
      console.error('[agent-report] month artifact failed:', err);
    }
    const finalReport: DailyReport = {
      ...full,
      html: html || nativeFullHtml || phase1.html,
      artifactStatus: 'rendered',
      model: html ? describeProvider().primary || full.model : full.model,
    };
    await saveDailyReport(finalReport);
    return finalReport;
  } catch (err) {
    console.error('[agent-report] month enrichment failed:', err);
    // Settle on the week edition so the page stops polling.
    const settled: DailyReport = { ...phase1, artifactStatus: 'rendered' };
    await saveDailyReport(settled).catch(() => undefined);
    return settled;
  }
}

// ---- Artifact composition --------------------------------------------------

async function composeArtifact(report: DailyReport, userId?: string | null): Promise<string | null> {
  const extras = await gatherBriefExtras(report, userId);
  const { text } = await generateTextForCurrentUser({
    feature: 'daily_report_artifact', // tiered cap → 32k output
    speed: 'primary',
    system: DESIGN_BRIEF,
    prompt: buildDataPrompt(report, extras),
  });
  return extractHtml(text);
}

// Strip any prose/markdown the model wrapped around the document and keep the
// HTML. Models occasionally fence the output or add a preamble; we want only
// the document so it can go straight into an iframe srcdoc.
function extractHtml(raw: string): string | null {
  let text = (raw || '').trim();
  const fence = text.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.search(/<!doctype html|<html[\s>]/i);
  if (start === -1) return null;
  text = text.slice(start).trim();
  // Trim anything after the closing tag (a trailing model note, etc.).
  const end = text.toLowerCase().lastIndexOf('</html>');
  if (end !== -1) text = text.slice(0, end + '</html>'.length);
  return text.length > 200 ? text : null;
}

// ---- Prompts ---------------------------------------------------------------

const DESIGN_BRIEF = `You are the user's chief of staff AND a world-class editorial designer/front-end engineer. You are handed the RAW material — the actual email bodies, the week's calendar, and the task board — and you do your OWN analysis: read the threads, judge what genuinely needs the user, connect the dots across mail/calendar/tasks, and compose a single, self-contained, beautiful HTML "Daily Brief". Polish of a Claude Artifact × a finely-typeset broadsheet.

ANALYZE, DON'T TRANSCRIBE:
- Read the email bodies in data.threads and decide for yourself what matters and why — do not parrot subjects. Form a real point of view. Each thread also carries the app's own first-pass read (whyItMatters, nextAction, openLoops, surfacedBecause, isNewSender) — treat it as a STARTING POINT you can sharpen or overrule with what you find in the bodies, never as text to copy verbatim.
- Build an INTEGRATED STORY: weave what needs the user now (recent mail) with what's coming (next 7 days of calendar + due tasks), drawing explicit connections ("Thu review with Sam ↔ his unanswered Tuesday thread ↔ prep task"). Use the richer fields you're given — task descriptions/labels/assignees, event descriptions/locations — to make those connections concrete.
- Be PROACTIVE, and you have real levers — propose AND wire them: to-dos (create_task), ready-to-send reply drafts in the user's voice (draft_reply), calendar holds for focus/prep/buffer (create_event), invite responses (rsvp_event), and clearing obvious noise (archive_thread). Nothing executes without a tap, so lean toward offering the action rather than just naming it.
- YOU HAVE FULL EDITORIAL CONTROL. Beyond the sections below, add whatever you judge genuinely useful for THIS person today and omit what isn't — e.g. a "Focus blocks" suggestion that proposes create_event holds around deep work, a "Waiting on others" list, a tight "Clear the noise" row of archivable FYIs, or a prep dossier for the day's most important meeting. Go deeper where it earns its space; stay calm and short on a light day. Never pad.
- Adaptive density: short and calm on a light day, fuller when it's busy. Never pad.

OUTPUT RULES (critical):
- Output ONLY a complete HTML document, starting with <!doctype html>. No markdown fences, no commentary.
- All CSS in one <style>, all JS in one <script>. The ONLY external resources allowed: (1) the artwork at data.art.imageUrl plus its data.art.fallbacks, (2) ONE Google Fonts <link> for the families below. Everything else inline. Render with no console errors; degrade gracefully when a section is empty.

DO NOT:
- Do NOT render a stat strip or counter tiles ("X scanned", "Y reply owed", "Z events"). Raw counts are noise — omit them entirely.
- The ONLY reference to data sources is a single small footer line at the very bottom: "Built for you using your <services> with care." — where <services> is data.services joined with commas and a final "and" (e.g. "Gmail, Calendar, and Tasks"). No other "sources/scanned/powered by" mentions anywhere.

MASTHEAD (signature element — replaces any app header):
- Full-bleed landscape banner using data.art.imageUrl (object-fit: cover, ~38–46vh, never distorted). Overlay "The {data.weekday} Brief" in the display face, centered, with a legibility scrim.
- RESILIENT IMAGE (required): the banner <img> MUST recover from a failed load. Give it an onerror handler that walks through data.art.fallbacks in order (set img.src to the next URL each time it errors); when the list is exhausted, clear onerror, hide the img, and leave the scrim/accent background so the masthead is never a blank void. data.art.fallbacks already ends with bundled local images, so a working banner is always reachable.
- Use data.localDate (e.g. "15 JUN 2026") and data.localTime (e.g. "9:54 AM") VERBATIM — they are already in the user's timezone; do not recompute or reformat times yourself. Set them vertically along the left/right edges, like a newspaper's spine.
- Small monospace caption beneath the image: data.art.credit + " · " + data.art.source.

THEME — TWO fonts, honoring the user's app theme (host injects live):
- Define on :root with fallbacks and use everywhere: --brief-bg (#faf9f6), --brief-ink (#1a1a1a), --brief-muted (#6b6b6b), --brief-hairline (#e6e3dc), --brief-accent (#c2683c), --brief-accent-soft (color-mix(in oklab, var(--brief-accent) 14%, transparent)), --brief-font-display ('Fraunces', Georgia, serif), --brief-font-body ('Geist', system-ui, sans-serif).
- Also define --brief-display-tracking: 0em; the host may override it. Apply letter-spacing: var(--brief-display-tracking) to masthead text and section headers, especially when the display face is Instrument/Instrument Sans.
- Headings/masthead use var(--brief-font-display); ALL body copy/UI uses var(--brief-font-body) — two clearly distinct typefaces, like the app.
- ONE Google Fonts link covering every option so live font swaps resolve instantly:
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400..700;1,9..144,400..600&family=Instrument+Serif:ital@0;1&family=Instrument+Sans:wght@400..700&family=Averia+Serif+Libre:wght@400;700&family=Geist:wght@400..700&family=Hanken+Grotesk:wght@400..700&display=swap">
- Live restyle listener: window.addEventListener('message', (e) => { const d = e.data; if (d && d.source === 'lab86-host' && d.type === 'theme' && d.theme) { for (const k in d.theme) document.documentElement.style.setProperty(k, d.theme[k]); } });

DESIGN: editorial, generous whitespace, clear hierarchy, responsive 360→1100px, tasteful load animations. Use inline SVG only where a visual genuinely adds insight (e.g. a slim timeline of the week's meetings) — never decorative number-counters.
- The calendar/"The week ahead" section must span the full content width. If the page uses CSS grid, set that section to grid-column: 1 / -1; never place it in a half-width column or narrow card.
- Calendar rows must never overlap or clip. Use non-absolute layout with width:100%, min-width:0, and a resilient grid such as grid-template-columns: minmax(7rem,max-content) minmax(0,1fr) auto; titles/locations use overflow-wrap:anywhere and can wrap to 2 lines. On narrow screens, stack time, title, and actions.
- Avoid fixed pixel widths for the agenda/table beyond sensible min/max columns. No table-fixed calendar layouts.

CONTENT (compose from your analysis; omit empty parts):
- An integrated narrative lede (2–3 short paragraphs, the user's voice/tone from data.voiceSamples) — the through-line of the day connecting mail, calendar, and tasks. No emoji.
- "Needs you": the threads YOU judged as needing action — person, your one-line read of why (from the body), how long it's sat, an open-thread button, and for reply-owed ones a proposed draft (in the user's voice) via the draft_reply action. For every existing thread, put data-thread-key="{thread.threadKey}" and data-received-at="{thread.lastReceivedAt}" on the enclosing row/card and render compact controls: a "done/resolved" checkmark that sends resolve_thread { account, threadId, subject, receivedAt: lastReceivedAt, trackedThreadId? } and a "remove from briefs" X that sends dismiss_thread { account, threadId, subject, receivedAt: lastReceivedAt }. On successful host ack, remove that row/card from the DOM. Treat this as permanent removal from future briefs unless the same thread receives newer mail after lastReceivedAt.
- "The week ahead": today → +7 days of calendar as a clean timeline/table; for notable meetings propose prep (context from related mail/threads, related tasks/docs, a short suggested agenda) and offer a one-tap prep task. When an event has a calendarId you may offer Yes/Maybe/No controls via rsvp_event, and you may propose a create_event focus/prep hold (reuse the account of a real event from data.calendar; pass startAt/endAt as epoch ms).
- Tasks woven in: surface due/overdue tasks linked to their source, and propose new tasks from the mail/meetings (create_task). Tasks are first-class, not a footnote. For every existing task with a cardId, put data-card-id="{cardId}" on the enclosing task row/card and render compact controls: a "complete" checkmark that sends toggle_task { cardId, completed: true, title } and a "remove from briefs" X that sends dismiss_task { cardId, title }. On successful host ack, remove that task row/card from the DOM so it disappears immediately and stays out of future briefs.
- From your tools (ONLY if data.mcp is non-empty): a compact section surfacing connected-tool items — GitHub issues/PRs awaiting you, Jira tickets assigned to you, Slack mentions. Give each a plain anchor to its url (target="_blank", rel="noopener"), show its source as a small badge (the data.mcp[].server value, capitalized) and its state. Fold genuinely actionable ones into the narrative or propose a task from them. Title the section by what it is (e.g. "Across your tools" / "Issues & tickets") — never use the word "MCP".

INTERACTION PROTOCOL (wire every interactive element):
- window.parent.postMessage({ source: 'lab86-daily-report', action, payload }, '*'). Actions:
  - 'open_thread'  { account, threadId }
  - 'open_view'    { view: 'mail'|'tasks'|'calendar' }
  - 'open_event'   { account, eventId }
  - 'resolve_thread' { account, threadId, subject?, receivedAt?, trackedThreadId? } // marks resolved and removes this conversation from future briefs; trackedThreadId is also resolved
  - 'dismiss_thread' { account, threadId, subject?, receivedAt? } // removes this conversation from future briefs until newer mail arrives
  - 'toggle_task'  { cardId, completed, title? }
  - 'dismiss_task' { cardId, title? }                  // removes from future briefs, does not complete/delete
  - 'create_task'  { title, dueAt? }                 // dueAt = epoch ms
  - 'draft_reply'  { account, threadId, body }       // opens the thread with your draft seeded
  - 'archive_thread' { account, threadId, subject?, receivedAt? } // archives the email and drops it from future briefs — use for clear noise/FYIs only
  - 'rsvp_event'   { account, calendarId, eventId, status }       // status: 'yes'|'no'|'maybe'; only when the event has a calendarId
  - 'create_event' { account, title, startAt, endAt, location?, description? } // startAt/endAt = epoch ms; schedule a focus/prep block or hold. Never add attendees.
- Host may ack on the same listener (e.data.source==='lab86-host' && e.data.action → e.data.ok/error). Update optimistically; reconcile on error.
- For archive_thread, put data-thread-key + data-received-at on the row like the dismiss controls so the host removes it on ack.
- Use the exact ids/accounts from the data; never invent ids. If an item lacks an id an action needs, render it without that action.`;

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

function buildDataPrompt(report: DailyReport, extras: BriefExtras): string {
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

  const data = {
    weekday,
    localDate,
    localTime,
    timezone: timeZone,
    kind: report.kind,
    art,
    firstName: contextFirstName() || null,
    services: [
      ...extras.services,
      ...[...new Set((report.sections.mcp ?? []).map((m) => m.server))].map(
        (s) => ({ github: 'GitHub', bitbucket: 'Bitbucket', jira: 'Atlassian/Jira', slack: 'Slack' })[s] || s,
      ),
    ],
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
    'Read data.threads (real email bodies), the calendar, and the tasks; do your own analysis and compose the Daily Brief HTML. Every id/account is real — use them verbatim in the interaction protocol; never fabricate ids.',
    '',
    '```json',
    JSON.stringify(data, null, 2),
    '```',
  ].join('\n');
}
