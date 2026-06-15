import { describeProvider } from '../ai/client';
import { contextFirstName } from '../ai/context';
import { generateTextForCurrentUser, hasAiForCurrentUser } from '../ai/gateway';
import type {
  DailyReport,
  DailyReportCalendarItem,
  DailyReportItem,
  DailyReportTaskItem,
} from '../shared/types';
import { saveDailyReport } from '../store/daily-reports';
import { getDailyArt } from './daily-art';
import { generateDailyReport } from './daily-report';

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
//   1. generateDailyReport() produces+saves the structured edition (the page
//      shows the rich fallback immediately, artifactStatus: 'composing').
//   2. the agent composes the HTML; we re-save the same _id with html attached
//      (artifactStatus: 'rendered').

const MAX_LANE = 8;
const MAX_TASKS = 20;
const MAX_EVENTS = 20;

export async function generateAgentReport(input: {
  kind: DailyReport['kind'];
  userId?: string | null;
  now?: number;
}): Promise<DailyReport> {
  // Step 1 — build the structured edition (also persists it so the page has
  // something rich to show while the artifact is being composed).
  const structured = await generateDailyReport({
    kind: input.kind,
    includeCalendar: true,
    userId: input.userId,
    now: input.now,
  });

  // No model available → the structured edition is the report. The page falls
  // back to its native renderer when `html` is absent.
  if (!(await hasAiForCurrentUser())) return structured;

  // Mark the structured edition as "composing" so the page shows a subtle
  // "designing your brief" hint over the fallback while the agent writes.
  await saveDailyReport({ ...structured, artifactStatus: 'composing' }).catch(() => undefined);

  try {
    const html = await composeArtifact(structured);
    if (html) {
      const withArtifact: DailyReport = {
        ...structured,
        html,
        artifactStatus: 'rendered',
        model: describeProvider().primary || structured.model,
      };
      await saveDailyReport(withArtifact);
      return withArtifact;
    }
  } catch (err) {
    console.error('[agent-report] artifact composition failed:', err);
  }
  // Composition failed — leave the structured edition in place (clear the
  // composing flag so the page stops hinting at an artifact that won't arrive).
  const fallback: DailyReport = { ...structured, artifactStatus: undefined };
  await saveDailyReport(fallback).catch(() => undefined);
  return fallback;
}

// ---- Artifact composition --------------------------------------------------

async function composeArtifact(report: DailyReport): Promise<string | null> {
  const { text } = await generateTextForCurrentUser({
    feature: 'daily_report_artifact',
    speed: 'primary',
    // Rich single-page documents need headroom; cap generously.
    maxOutputTokens: 16000,
    system: DESIGN_BRIEF,
    prompt: buildDataPrompt(report),
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

const DESIGN_BRIEF = `You are a world-class editorial designer AND front-end engineer composing a personal "Daily Brief" — a single, self-contained, beautiful HTML document from the data you are given. Think of the polish of a Claude Artifact crossed with a finely-typeset broadsheet newspaper and a modern analytics dashboard.

OUTPUT RULES (critical):
- Output ONLY a complete HTML document, starting with <!doctype html>. No markdown fences, no commentary before or after.
- All CSS in a single <style> tag, all JS in a single <script> tag. The ONLY permitted external resources are: (1) the daily artwork image at the exact data.art.imageUrl, and (2) a Google Fonts <link> for the three fonts named below. Everything else inline; draw charts as inline SVG. No other network requests.
- It must render correctly with no console errors and degrade gracefully if a data section is empty.

MASTHEAD (the signature element — replaces any app header):
- Open with a full-bleed landscape banner using data.art.imageUrl as the image (object-fit: cover, ~38–46vh tall, never distorted). Overlay the title in a large serif display face: "The {data.weekday} Brief" (e.g. "The Monday Brief"), centered, with a soft scrim/legibility gradient so the text reads over any painting.
- Flank the masthead with the full date (e.g. "15 JUN 2026") and the time of day, set vertically along the left and right edges (rotated), tabular and understated — like a newspaper's spine.
- Directly beneath the image, a small monospace attribution caption: data.art.credit + " · " + data.art.source.

THEME (must honor the user's app theme, set live by the host):
- Define these CSS custom properties on :root WITH the given fallbacks, and use them everywhere instead of hardcoded colors/fonts:
  --brief-bg (#faf9f6), --brief-ink (#1a1a1a), --brief-muted (#6b6b6b), --brief-hairline (#e6e3dc),
  --brief-accent (#c2683c), --brief-accent-soft (color-mix(in oklab, var(--brief-accent) 14%, transparent)),
  --brief-font-display ('Fraunces', Georgia, serif), --brief-font-body ('Geist', system-ui, sans-serif).
- Load the app fonts via ONE Google Fonts link so live font switches resolve instantly:
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400..700;1,9..144,400..600&family=Averia+Serif+Libre:wght@400;700&family=Geist:wght@400..700&display=swap">
- Include this listener so the host can restyle live: window.addEventListener('message', (e) => { const d = e.data; if (d && d.source === 'lab86-host' && d.type === 'theme' && d.theme) { for (const k in d.theme) document.documentElement.style.setProperty(k, d.theme[k]); } }); — apply on load via the same path.
- Headlines/masthead use var(--brief-font-display); body/UI use var(--brief-font-body). Accent elements use var(--brief-accent).

DESIGN:
- Editorial, confident, generous whitespace. Clear typographic hierarchy. Fully responsive (looks great 360px → 1100px). Use CSS grid/flex. Subtle, tasteful load animations.
- Rich data viz where it helps, drawn as INLINE SVG from the numbers: e.g. a small bar chart of lane volumes, a donut of task open/done, a horizontal timeline of today's calendar. Always pair a chart with the literal numbers.

CONTENT (use what the data supports; omit empty sections gracefully):
- A stylized narrative lede (2–3 short paragraphs) — expand the provided narrative seed into warm, sharp chief-of-staff prose. No emoji.
- A stat strip (scanned, reply owed, tracked, open tasks, events) with a small chart.
- "Needs you" — reply-owed and follow-up-owed conversations as rich rows: person, subject, why it matters, elapsed framing, and an action button to open the thread.
- "New people" and "Tracked conversations" sections.
- An interactive TO-DO list from the tasks data: a checkbox per task (toggling calls the host — see PROTOCOL), title, due date, priority, and a link to its source if present. Include a "+ add task" affordance.
- A calendar section: today/upcoming events as a clean table or timeline with time, title, location; clicking opens the event.
- A collapsed "noise / bulk" tail.

INTERACTION PROTOCOL (wire every interactive element to this):
- To act, post a message to the host: window.parent.postMessage({ source: 'lab86-daily-report', action, payload }, '*').
- Supported actions and payloads:
  - 'open_thread'  { account, threadId }            // open an email conversation
  - 'open_view'    { view: 'mail'|'tasks'|'calendar' } // jump to an app surface
  - 'toggle_task'  { cardId, completed }            // check/uncheck a to-do
  - 'create_task'  { title, dueAt? }                // add a to-do (dueAt = epoch ms)
  - 'open_event'   { account, eventId }             // open a calendar event
- The host may post an acknowledgement back to you (same listener as the theme message): if (e.data?.source === 'lab86-host' && e.data.action) { /* e.data.ok, e.data.error */ }. Use it to confirm optimistic UI; never block on it.
- Optimistically update the UI on click (e.g. strike a checked task) and reconcile if the host reports an error.
- Use the exact ids/accounts from the data. Never invent ids. If an item lacks an id needed for an action, render it without that action.`;

function buildDataPrompt(report: DailyReport): string {
  const s = report.sections;
  const lane = (items: DailyReportItem[] = []) =>
    items.slice(0, MAX_LANE).map((i) => ({
      account: i.account,
      threadId: i.threadId,
      people: i.people,
      subject: i.subject,
      whyItMatters: i.whyItMatters,
      nextAction: i.nextAction,
      dueAt: i.dueAt ?? null,
      receivedAt: i.receivedAt ?? null,
      lane: i.lane,
      isNewSender: i.isNewSender ?? false,
    }));
  const tasks = (s.tasks ?? []).slice(0, MAX_TASKS).map((t: DailyReportTaskItem) => ({
    cardId: t.cardId,
    boardTitle: t.boardTitle,
    columnName: t.columnName,
    title: t.title,
    dueAt: t.dueAt ?? null,
    priority: t.priority,
    completed: Boolean(t.completedAt),
    sourceUrl: t.sourceUrl ?? null,
    sourceTitle: t.sourceTitle ?? null,
  }));
  const calendar = (s.calendar ?? []).slice(0, MAX_EVENTS).map((e: DailyReportCalendarItem) => ({
    account: e.account,
    eventId: e.eventId,
    title: e.title,
    startAt: e.startAt,
    endAt: e.endAt,
    allDay: e.allDay ?? false,
    location: e.location ?? null,
  }));

  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(new Date(report.generatedAt));
  const art = getDailyArt(report.generatedAt);

  const data = {
    kind: report.kind,
    generatedAt: report.generatedAt,
    weekday,
    art,
    firstName: contextFirstName() || null,
    narrativeSeed: report.narrative,
    stats: report.stats,
    sections: {
      replyOwed: lane(s.replyOwed),
      followUpOwed: lane(s.followUpOwed),
      newPeople: lane(s.newPeople),
      timeSensitive: lane(s.timeSensitive),
      tracked: lane(s.tracked),
      fyi: lane(s.fyi),
      bulkTailCount: (s.bulkTail ?? []).length,
      noiseSummary: s.noiseSummary ?? null,
    },
    tasks,
    calendar,
  };

  return [
    `Today is ${new Date(report.generatedAt).toString()}.`,
    `This is the "${report.kind}" edition.`,
    'Compose the Daily Brief HTML document from the following data. Every id/account is real — use them verbatim in the interaction protocol; never fabricate.',
    '',
    '```json',
    JSON.stringify(data, null, 2),
    '```',
  ].join('\n');
}
