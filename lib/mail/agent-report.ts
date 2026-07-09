import { randomUUID } from 'node:crypto';
import { describeProvider } from '../ai/client';
import { contextFirstName, getAiRequestContext, runWithAiRequestContext } from '../ai/context';
import { generateTextForCurrentUser, resolveAiRuntime } from '../ai/gateway';
import { listNylasAccounts } from '../nylas/provider';
import { type BriefComposition, compositionFromReport } from '../shared/brief-composition';
import { withDeadline } from '../shared/deadline';
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
import { type BriefWeather, briefWeather, type FetchLike } from '../weather/open-meteo';
import { briefServiceFromProvider, briefServicesFromIds } from './brief-services';
import { resolveBriefTimezone } from './brief-timezone';
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

// Deadlines for the pipeline's unbounded awaits. A deploy/restart mid-run
// SIGTERMs the process (no catch runs), but a plain hang used to wedge the
// stored edition at 'composing'/'enriching' forever. With deadlines, hangs
// become caught errors that settle the edition to 'rendered' with an
// artifactError; the store's settle-on-read migration is the backstop for the
// SIGTERM case. Generous ceilings: these exist to catch hangs, not slowness.
const EXTRAS_DEADLINE_MS = 60_000;
const ARTIFACT_LLM_DEADLINE_MS = 240_000;
const MONTH_ENRICH_DEADLINE_MS = 300_000;
const WEATHER_DEADLINE_MS = 12_000;
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
  // Real local weather (Open-Meteo, keyless) for the brief's weather module.
  // Null when no location can be resolved — the module is simply omitted.
  weather?: BriefWeatherPack | null;
}

// The compact, prompt-ready weather shape handed to the artifact model.
export interface BriefWeatherPack {
  location: string;
  unit: '°F' | '°C';
  current: {
    temp: number;
    condition: string;
    high: number;
    low: number;
    windSpeed?: number;
    humidity?: number;
  };
  hourly: Array<{ hour: string; temp: number; condition: string }>;
  daily: Array<{ day: string; condition: string; high: number; low: number; precipChance?: number }>;
}

function hourLabel(timeIso: string): string {
  const match = /T(\d{2})/.exec(timeIso);
  if (!match) return timeIso;
  const hour = Number(match[1]);
  if (hour === 0) return '12 AM';
  if (hour === 12) return '12 PM';
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}

// BriefWeather → the compact pack the artifact prompt consumes. Pure + exported
// so the shape the model sees is unit-tested directly.
export function toBriefWeather(weather: BriefWeather): BriefWeatherPack {
  return {
    location: weather.locationName,
    unit: weather.unit === 'fahrenheit' ? '°F' : '°C',
    current: {
      temp: Math.round(weather.current.temperature),
      condition: weather.current.conditionLabel,
      high: weather.current.tempMax,
      low: weather.current.tempMin,
      windSpeed: weather.current.windSpeed !== undefined ? Math.round(weather.current.windSpeed) : undefined,
      humidity: weather.current.humidity,
    },
    hourly: weather.hourly.slice(0, 12).map((point) => ({
      hour: hourLabel(point.timeIso),
      temp: Math.round(point.temperature),
      condition: point.conditionCode,
    })),
    daily: weather.daily.slice(0, 7).map((day) => ({
      day: day.label,
      condition: day.conditionCode,
      high: Math.round(day.tempMax),
      low: Math.round(day.tempMin),
      precipChance: day.precipitationChance !== undefined ? Math.round(day.precipitationChance) : undefined,
    })),
  };
}

// Calendar locations that plausibly geocode (skip meeting links and rooms).
const NON_PLACE_LOCATION = /https?:\/\/|zoom|meet\.|teams|webex|conference room|room \d|call|dial/i;

export function weatherLocationCandidates(calendar: DailyReportCalendarItem[] | undefined): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const event of calendar ?? []) {
    const location = String(event.location || '').trim();
    if (!location || location.length < 4 || NON_PLACE_LOCATION.test(location)) continue;
    // Favor address-like strings: a comma ("Rochester, NY") or a digit+word mix.
    if (!/,|\d/.test(location)) continue;
    const key = location.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(location);
    if (candidates.length >= 3) break;
  }
  return candidates;
}

async function gatherBriefWeather(
  report: DailyReport,
  fetchImpl?: FetchLike,
): Promise<BriefWeatherPack | null> {
  const timezone = getAiRequestContext().userTimezone;
  try {
    const weather = await withDeadline(
      briefWeather(
        { timezone, candidates: weatherLocationCandidates(report.sections.calendar) },
        fetchImpl ? { fetchImpl } : {},
      ),
      WEATHER_DEADLINE_MS,
      'Brief weather',
    );
    return weather ? toBriefWeather(weather) : null;
  } catch (err) {
    console.warn('[agent-report] weather gathering failed (brief continues without it):', err);
    return null;
  }
}

function cleanBody(message: Message): string {
  const raw = message.textBody || message.snippet || '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_BODY_CHARS);
}

// Pulls the ACTUAL message bodies for the action-worthy threads (plus the
// user's own outbound prose as a voice sample) so the agent analyzes real
// content rather than pre-canned one-liners. Bounded for token cost.
export async function gatherBriefExtras(
  report: DailyReport,
  userId?: string | null,
  opts: { weatherFetch?: FetchLike } = {},
): Promise<BriefExtras> {
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

  const weather = await gatherBriefWeather(report, opts.weatherFetch);

  return { digests, voiceSamples, services, weather };
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

export function settleMonthSaveFailureReport(input: {
  phase1: DailyReport;
  failure: DailyReportArtifactError;
}): DailyReport {
  return withArtifactError({ ...input.phase1, artifactStatus: 'rendered' }, input.failure);
}

export async function generateAgentReport(input: {
  kind: DailyReport['kind'];
  userId?: string | null;
  now?: number;
  reportId?: string;
}): Promise<DailyReport> {
  // The brief's dateline, weather geocoding, and calendar formatting all read
  // the context timezone. A usable context value (browser header — tracks
  // travel — or the cron's calendar guess) stands; when it is missing or
  // UTC-filler, resolve one from the user's synced calendars and run the
  // whole pipeline under it.
  const context = getAiRequestContext();
  const userTimezone = await resolveBriefTimezone(input.userId ?? context.userId, context.userTimezone);
  return runWithAiRequestContext({ ...context, userTimezone }, () => runAgentReport(input));
}

async function runAgentReport(input: {
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
    // The silent month pass never persists, so abandoning it on deadline
    // cannot write behind the settled edition.
    const full = await withDeadline(
      generateDailyReport({
        kind: input.kind,
        includeCalendar: true,
        userId: input.userId,
        now: input.now,
        scope: 'full',
        reportId,
        silent: true,
      }),
      MONTH_ENRICH_DEADLINE_MS,
      'Month enrichment',
    );
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
    // If the enriched month edition fails to persist (for example because the
    // full AI artifact exceeded the backing store's document limits), do not
    // leave the already-visible week artifact polling forever at 'enriching'.
    const settled = settleMonthSaveFailureReport({
      phase1,
      failure: artifactError('month_enrichment', err),
    });
    try {
      await saveDailyReport(settled);
      return settled;
    } catch (saveErr) {
      console.error('[agent-report] month report save-failure fallback save failed:', saveErr);
      throw err;
    }
  }

  return finalReport;
}

// ---- Artifact composition --------------------------------------------------

async function composeArtifactHtml(report: DailyReport, userId?: string | null): Promise<string> {
  // Deadlines route hangs into the callers' week_artifact/month_artifact catch
  // paths, which settle the edition with a fallback artifact + artifactError.
  const extras = await withDeadline(
    gatherBriefExtras(report, userId),
    EXTRAS_DEADLINE_MS,
    'Brief context gathering',
  );
  const { text } = await withDeadline(
    generateTextForCurrentUser({
      feature: 'daily_report_artifact', // tiered cap → 32k output
      speed: 'primary',
      userId,
      system: HTML_ARTIFACT_BRIEF,
      prompt: buildDataPrompt(report, extras),
    }),
    ARTIFACT_LLM_DEADLINE_MS,
    'Brief artifact generation',
  );
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

export const HTML_ARTIFACT_BRIEF = `You are the user's chief of staff AND a world-class editorial designer/front-end engineer. You are handed the RAW material — actual email bodies, the week's calendar, tasks, and connected tool items — and you do your OWN analysis: read the threads, judge what genuinely needs the user, connect the dots across mail/calendar/tasks/tools, and compose a single, self-contained, beautiful HTML "Daily Brief". Polish of a Claude Artifact × a finely-typeset broadsheet.

ANALYZE, DON'T TRANSCRIBE:
- Read the email bodies in data.threads and decide for yourself what matters and why — do not parrot subjects. Form a real point of view. Each thread may also carry the app's first-pass read (whyItMatters, nextAction, openLoops, surfacedBecause, isNewSender); treat that as a STARTING POINT you can sharpen or overrule with your own reading.
- Build an INTEGRATED STORY: weave what needs the user now (recent mail) with what's coming (next 7 days of calendar + due tasks), drawing explicit connections ("Thu review with Sam ↔ his unanswered Tuesday thread ↔ prep task").
- Be PROACTIVE: propose to-dos, meeting prep, ready-to-send reply drafts, calendar holds, invite responses, and cleanup actions when the data supports them. Nothing mutates without a user tap and host confirmation.
- Adaptive density: short and calm on a light day, fuller when it's busy. Never pad.

OUTPUT RULES (critical):
- Output ONLY a complete HTML document, starting with <!doctype html>. No markdown fences, no commentary.
- All CSS in one <style>, all JS in one <script>. The ONLY external resources allowed: (1) data.art.imageUrl and data.art.fallbacks, (2) ONE Google Fonts <link> for the families below. Everything else inline. Render with no console errors; degrade gracefully when a section is empty.
- Use real ids/accounts from the data only. Never invent ids. If an item lacks the ids/accounts needed for an action, render it without that action.
- Action controls MUST be regular clickable elements with data-action and data-payload attributes. The host-injected runtime posts messages for you. Do not invent action names.
- data-payload MUST be a valid JSON object string containing exact ids/accounts from the JSON. Escape it correctly for HTML attributes.

DO NOT:
- Do NOT set text in ALL CAPS, anywhere. No uppercase letter-spaced micro-labels ("RESPOND", "WAIT / CLEAR", "SUGGESTED REPLY", "YOUR MOVE"), no text-transform: uppercase in CSS, no all-caps kickers, datelines, section titles, tags, or buttons. Sentence case everywhere — section titles, kickers, tags, chips, and action labels. Acronyms (RSVP, PDF) stay as written.
- Do NOT render a stat strip or counter tiles ("X scanned", "Y reply owed", "Z events"). Raw counts are noise — omit them entirely.
- Do NOT include "With love from Lab86".
- Do NOT include a second app toolbar or app chrome.
- Do NOT make the artifact mostly bordered cards, plain paragraphs, and generic buttons. That is a failed design unless the day is almost empty.
- Do NOT use sharp-corner default web buttons or undifferentiated button rows. The action language should feel designed and native to the artifact.
- Do NOT use action names outside VALID ACTIONS, including "reply", "open", "email", "schedule", "snooze", "complete", or "view".

MASTHEAD (signature element — replaces any app header):
- Full-bleed landscape banner using data.art.imageUrl (object-fit: cover, ~38–46vh, never distorted). Overlay "The {data.weekday} Brief" in the display face, centered, with a legibility scrim.
- Use data.localDate (e.g. "Jun 15, 2026") and data.localTime (e.g. "9:54 AM") VERBATIM — they are already in the user's timezone; do not recompute or reformat times yourself. Set them vertically along the left/right edges, like a newspaper's spine.
- Dateline honesty: never derive or print a city, region, or place name from data.timezone, the art credit, or anything else you infer. The ONLY place name you may print anywhere in the brief is data.weather.location (a real, resolved location). When data.weather is null, the dateline and masthead carry only the edition name, date, and time — no city.
- Small monospace caption beneath or inside the image: data.art.credit + " · " + data.art.source.
- Image fallback is REQUIRED: use an <img> for the art with data.art.imageUrl as src and wire data.art.fallbacks through an onerror handler or equivalent inline JS so the masthead never shows a broken image. If all art URLs fail, hide the img and use a theme-token background.

WEATHER MODULE (required whenever data.weather is non-null; omit entirely when null):
- Place it near the masthead/lede — in the lede's margin rail, as a slim band directly beneath the masthead, or docked beside the dateline. It is part of the paper's front matter, not a buried section.
- Visual anatomy (a designed weather instrument, matching the polish of a native weather widget): ONE large temperature figure in the display face (data.weather.current.temp + data.weather.unit), a condition line beneath it (data.weather.current.condition, with high/low as "H 78° / L 61°"), then a compact strip — either the next hours (data.weather.hourly: hour label + small temp, 6–8 entries) or the week (data.weather.daily: day label + condition + high/low range), whichever better serves the day. Location name in small caps-free muted type.
- Optional refinement when daily data is rich: render the 7-day span as slim horizontal range bars (min→max) on a shared temperature scale — hairline track in var(--brief-hairline), filled span in var(--brief-accent-2, var(--brief-accent)).
- Style with theme tokens only: temperature figure in var(--brief-ink), condition and strip labels in var(--brief-muted), accents/rules on the module in var(--brief-accent-2, var(--brief-accent)). No weather clip-art, no emoji; a minimal inline-SVG glyph per condition (sun disc, cloud outline, rain strokes) drawn with token strokes is welcome.
- Weave it into the lede when relevant ("rain by 3 PM argues for the morning errand"), and never invent weather — data.weather is real.

STYLIZED LEDE SYSTEM (required after the masthead):
- The lede is a designed editorial object, not a plain paragraph block. Implement it with your own CSS in the document; do not use external libraries.
- Choose exactly ONE treatment from this internal lede treatment library, based on the day's content:
  1. Illuminated brief: large drop initial, 2-3 short body paragraphs, and a narrow margin rail naming the day's main tension.
  2. Dispatch deck: a compact headline/deck, a ruled side note, and 2-3 short paragraphs in a constrained measure.
  3. Correspondence map: names/entities as small connected labels around the lede, showing who needs what.
  4. Agenda score: a lede paired with a tiny inline timeline or beat marks for today's sequence.
  5. Decision ledger: a lede split into "respond / wait / prepare" columns when the day is action-heavy.
  6. Quiet bulletin: restrained paragraph stack with a pull quote and captioned rule for light days.
- The lede must still read cleanly as 2-3 short body paragraphs in the user's tone from data.voiceSamples. No emoji.

THEME — TWO fonts, honoring the user's app theme (host injects live):
- Define on :root with fallbacks and use everywhere: --brief-bg (#faf9f6), --brief-ink (#1a1a1a), --brief-muted (#6b6b6b), --brief-hairline (#e6e3dc), --brief-accent (#c2683c), --brief-accent-soft (color-mix(in oklab, var(--brief-accent) 14%, transparent)), --brief-accent-2 (#774914), --brief-font-display ('Fraunces', Georgia, serif), --brief-font-body ('Geist', system-ui, sans-serif), --brief-display-tracking (0em).
- Headings/masthead use var(--brief-font-display); ALL body copy/UI uses var(--brief-font-body). Apply var(--brief-display-tracking) to display/header text.
- TWO accent voices: --brief-accent is the ACTION voice (buttons, chips, emphasis fills). --brief-accent-2 is the EDITORIAL voice — use var(--brief-accent-2, var(--brief-accent)) for section header text, kicker/deck lines, hairline-accent rules under headers, margin-rail labels, and chart/strip accents (including the weather module). Every section header and its rule should carry the accent-2 voice; never use accent-2 for action fills.
- ONE Google Fonts link covering every option so live font swaps resolve instantly:
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400..700;1,9..144,400..600&family=Instrument+Serif:ital@0;1&family=Instrument+Sans:wght@400..700&family=Averia+Serif+Libre:wght@400;700&family=Geist:wght@400..700&family=Hanken+Grotesk:wght@400..700&display=swap">
- Live restyle listener: window.addEventListener('message', (e) => { const d = e.data; if (d && d.source === 'lab86-host' && d.type === 'theme' && d.theme) { for (const k in d.theme) document.documentElement.style.setProperty(k, d.theme[k]); } });

LIGHT AND DARK MODE REQUIREMENTS:
- Design for both light and dark from the start; do not make a dark-only page and hope token injection fixes it.
- Define usable :root fallbacks for light mode and include @media (prefers-color-scheme: dark) that remaps only --brief-* tokens; the host may override both.
- Every layer must be semantic: page background, elevated surfaces, subtle fills, hairlines, accent fills, muted text, focus rings, chart strokes/fills, action controls, and art scrims derive from --brief-* tokens with color-mix/opacity.
- Before final output, mentally check both modes: body copy readable, muted text visible, actions obvious, chart marks distinguishable, masthead title legible.

DESIGN:
- Editorial, generous whitespace, clear hierarchy, responsive 360→1100px, tasteful load animations. Use inline SVG only where a visual genuinely adds insight — e.g. a slim timeline of the week's meetings, a relationship map, a waiting-on matrix, a prep dossier, or a tool-workflow board. Never decorative number-counters.
- CHART STANDARD (inline SVG): charts follow the same restrained grammar as a modern component library — no chart junk. Hairline axes/gridlines in var(--brief-hairline) (horizontal only, skip verticals), small muted tick labels in var(--brief-muted), bars with a small corner radius or 2px-stroke lines in var(--brief-accent-2, var(--brief-accent)) (multi-series may add var(--brief-accent)), direct labels over a legend when there are ≤2 series, generous inner padding, no 3D, no drop shadows, no gradient fills. A chart earns its place only when it explains real data (meeting load by day, waiting-time by person) — never decoration.
- Claude Artifact design skill: invent a visual grammar for THIS day. Use spatial relationships, sequencing, comparison, annotation, rhythm, and interaction. At least one component should be memorable by form ("the week rail", "the relationship map", "the prep dossier"), not just by content.
- REQUIRED VISUAL MODULES: when there is enough data, include at least TWO custom visual modules beyond the masthead; one must be temporal if calendar/tasks exist.
- TIMELINE STANDARD: "The week ahead" must be a designed timeline/agenda system with rhythm, connectors, time bands, day groupings, or swimlanes. Do not render it as loose repeated day cards.
- ACTION DESIGN: action controls may be chips, tabs, stamps, margin actions, inline labels, or rail controls, but they must be integrated into the artifact. Avoid rows of large generic rectangles.

AI SLOP BAN LIST — before final output, ensure none of these dominate:
- Generic hero/subtitle/CTA formula; purple/blue gradient SaaS palette; decorative glow blobs; equal feature cards; repeated bordered cards for everything; fake stats; generic section names; stock icon/emoji decoration; glassmorphism as hierarchy; full-width paragraph blocks; timelines without time/connectors; charts that decorate instead of explaining; components that would still make sense if the real mail/calendar/task content were swapped out.

CONTENT (compose from your analysis; omit empty parts):
- A stylized integrated lede from the STYLIZED LEDE SYSTEM — the through-line of the day connecting mail, calendar, tasks, and connected tools.
- "Needs you": the threads YOU judged as needing action — person, your one-line read of why from the body, how long it's sat, an open-thread button, and for reply-owed ones a proposed draft (in the user's voice) via draft_reply.
- "The week ahead": today → +7 days of calendar as a clean timeline/table/swimlane; for notable meetings propose prep (attendees & context, related tasks/docs, a short suggested agenda) and offer a one-tap prep task.
- Tasks woven in: surface due/overdue tasks linked to their source, and propose new tasks from mail/meetings (create_task). Tasks are first-class, not a footnote.
- Add other sections only if they improve this specific day: waiting on others, clear the noise, prep dossier, GitHub/tool digest, focus blocks, travel/logistics, or decision queue.

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
  // Sentence-case dateline ("Jun 15, 2026") — the ALL-CAPS treatment is banned.
  const localDate = fmt({ day: '2-digit', month: 'short', year: 'numeric' });
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
    // Real local weather (already fetched; render the weather module from it).
    weather: extras.weather ?? null,
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
