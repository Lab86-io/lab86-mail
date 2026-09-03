import { randomUUID } from 'node:crypto';
import { contextFirstName, getAiRequestContext, runWithAiRequestContext } from '../ai/context';
import { generateTextForCurrentUser, resolveAiRuntime } from '../ai/gateway';
import { api, convexQuery } from '../hosted/convex';
import { compositionFromReport } from '../shared/brief-composition';
import type { BriefDocumentV2 } from '../shared/brief-document';
import { dailyBriefEditionTitleAt, normalizeBriefTimezone } from '../shared/brief-edition';
import { withDeadline } from '../shared/deadline';
import {
  type DailyReport,
  type DailyReportArtifactError,
  type DailyReportArtifactErrorStage,
  type DailyReportItem,
  MAX_ARTIFACT_ERROR_MESSAGE_CHARS,
  MAX_ARTIFACT_ERRORS,
  type Message,
} from '../shared/types';
import { getDailyReport, saveDailyReport } from '../store/daily-reports';
import { getThreadMessages } from '../store/messages';
import { type AreaPulseRecord, budgetAreaLines } from './brief-areas';
import { type BudgetAreaLine, composeBudgetBriefDocument } from './brief-budget-document';
import { resolveBriefPlanTier } from './brief-plan';
import { type BriefProseItemInput, type BriefProseResult, writeBriefProse } from './brief-prose';
import type { BriefLane } from './brief-score';
import { resolveBriefTimezone } from './brief-timezone';
import { gatherBriefWeather, weatherSentence } from './brief-weather';
import { generateDailyReport } from './daily-report';
import { buildNativeDailyReportArtifact } from './report-artifact';

// The budget Daily Brief (2026-09-03).
//
// One structured pass (generateDailyReport: candidates, deterministic floor,
// deterministic score, bounded enrichment), then ONE prose model call that
// writes the lede, one line per selected item, and the week ahead. The
// document layout is deterministic (composeBudgetBriefDocument). The
// deterministic HTML artifact stays beside the document for old clients.

// Deadlines for the pipeline's unbounded awaits. A hang becomes a caught error
// that settles the edition instead of wedging it at 'composing'.
const CONTEXT_DEADLINE_MS = 45_000;
const PROSE_DEADLINE_MS = 120_000;
const MAX_MSGS_PER_ITEM = 3;
const MAX_BODY_CHARS = 700;

// Progressive callbacks can outlive withDeadline(): Promise.race rejects the
// caller but cannot cancel a running model loop. Closing waits for an in-flight
// write, prevents later writes, and lets the caller persist the terminal state.
export function createGenerationScopedWriter<T>(persist: (value: T) => Promise<void>) {
  let active = true;
  let pending: Promise<void> = Promise.resolve();

  return {
    write(value: T): Promise<void> {
      if (!active) return Promise.resolve();
      const operation = pending.then(async () => {
        if (!active) return;
        await persist(value);
      });
      pending = operation.catch(() => undefined);
      return operation;
    },
    async close(): Promise<void> {
      active = false;
      await pending;
    },
  };
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

export function withArtifactError(report: DailyReport, error: DailyReportArtifactError): DailyReport {
  return {
    ...report,
    artifactErrors: [...(report.artifactErrors || []), error].slice(-MAX_ARTIFACT_ERRORS),
  };
}

export async function generateAgentReport(input: {
  kind: DailyReport['kind'];
  userId?: string | null;
  now?: number;
  reportId?: string;
}): Promise<DailyReport> {
  // The dateline, the weather, and the week-ahead weekday names all read the
  // context timezone. A usable context value stands; when it is missing or
  // UTC-filler, resolve one from the user's synced calendars.
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
  const reportId = input.reportId ?? randomUUID();
  const tier = await resolveBriefPlanTier(input.userId);

  let structured: DailyReport;
  try {
    structured = await generateDailyReport({
      kind: input.kind,
      includeCalendar: true,
      userId: input.userId,
      now: input.now,
      scope: 'week',
      reportId,
      tier,
    });
  } catch (err) {
    // The pass persists a 'partial' edition before the work that can throw.
    // Settle it so the UI does not stay stuck on a dead run.
    console.error('[agent-report] structured pass failed:', err);
    const partial = await getDailyReport(reportId).catch(() => null);
    if (partial) {
      await saveDailyReport({ ...partial, status: 'ready', artifactStatus: 'rendered' }).catch(
        () => undefined,
      );
    }
    throw err;
  }

  const composition = compositionFromReport(structured);
  const html = buildNativeDailyReportArtifact(structured, composition);
  await saveDailyReport({
    ...structured,
    composition,
    html,
    artifactStatus: 'composing',
    artifactSource: 'deterministic',
  }).catch(() => undefined);

  // No model: the document still composes deterministically. The exact
  // availability error is recorded so the UI can explain the plain letter.
  let availability: DailyReportArtifactError | undefined;
  let generate: typeof generateTextForCurrentUser | null = generateTextForCurrentUser;
  try {
    await resolveAiRuntime({ userId: input.userId, speed: 'primary', feature: 'daily_brief_prose' });
  } catch (err) {
    availability = artifactError('ai_availability', err);
    generate = null;
  }

  try {
    const composed = await composeBudgetBrief(structured, input.userId, { generate });
    const report = finalizeBudgetReport(structured, composed);
    const settled = availability ? withArtifactError(report, availability) : report;
    await saveDailyReport(settled);
    return settled;
  } catch (err) {
    console.error('[agent-report] budget composition failed:', err);
    const fallback = withArtifactError(
      {
        ...structured,
        composition,
        html,
        artifactStatus: 'rendered',
        artifactSource: 'deterministic',
      },
      artifactError('document_v2', err),
    );
    await saveDailyReport(fallback);
    return fallback;
  }
}

// ---- Budget composition ----------------------------------------------------

export interface ComposedBudgetBrief {
  document: BriefDocumentV2;
  prose: BriefProseResult;
  areas: BudgetAreaLine[];
}

export interface ComposeBudgetBriefDeps {
  generate?: typeof generateTextForCurrentUser | null;
  loadMessages?: (account: string, threadId: string) => Promise<Message[]>;
  loadAreaPulses?: (userId: string) => Promise<AreaPulseRecord[]>;
  loadWeather?: (report: DailyReport, userId: string | null | undefined) => Promise<string | null>;
  now?: number;
}

function selectedItems(report: DailyReport): Array<{ item: DailyReportItem; lane: BriefLane }> {
  const s = report.sections;
  return [
    ...(s.answer ?? []).map((item) => ({ item, lane: 'answer' as const })),
    ...(s.today ?? []).map((item) => ({ item, lane: 'today' as const })),
    ...(s.know ?? []).map((item) => ({ item, lane: 'know' as const })),
  ];
}

function cleanBody(message: Message): string {
  const raw = message.textBody || message.snippet || '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_BODY_CHARS);
}

async function loadAreaPulsesFromConvex(userId: string): Promise<AreaPulseRecord[]> {
  const rows = await convexQuery<any[]>((api as any).albatrossAreaPulse.listAreaPulses, {
    userId,
    limit: 12,
  });
  return (rows || []).map((row) => ({ areaId: String(row.areaId), pulse: row.pulse ?? null }));
}

async function loadWeatherSentence(report: DailyReport, userId: string | null | undefined) {
  return weatherSentence(await gatherBriefWeather(report, userId));
}

// Gathers the real message bodies for the selected items, asks the model for
// the prose once, and composes the deterministic document.
export async function composeBudgetBrief(
  report: DailyReport,
  userId: string | null | undefined,
  deps: ComposeBudgetBriefDeps = {},
): Promise<ComposedBudgetBrief> {
  const loadMessages = deps.loadMessages ?? getThreadMessages;
  const timezone = normalizeBriefTimezone(getAiRequestContext().userTimezone);
  const now = deps.now ?? report.generatedAt ?? Date.now();

  const gather = async () => {
    const items: BriefProseItemInput[] = [];
    for (const { item, lane } of selectedItems(report)) {
      let messages: Message[] = [];
      try {
        messages = await loadMessages(item.account, item.threadId);
      } catch {
        messages = [];
      }
      messages.sort((a, b) => Number(a.date || 0) - Number(b.date || 0));
      items.push({
        key: `${item.account}:${item.threadId}`,
        lane,
        sender: item.sender || item.people[0] || '',
        subject: item.subject,
        receivedAt: item.receivedAt ?? null,
        dueAt: item.dueAt ?? null,
        whyItMatters: item.whyItMatters,
        messages: messages
          .slice(-MAX_MSGS_PER_ITEM)
          .map((m) => ({ from: m.from, date: m.date ?? null, body: cleanBody(m) }))
          .filter((m) => m.body.length > 0),
      });
    }
    const [pulses, weather] = await Promise.all([
      userId
        ? (deps.loadAreaPulses ?? loadAreaPulsesFromConvex)(userId).catch(() => [] as AreaPulseRecord[])
        : Promise.resolve([] as AreaPulseRecord[]),
      deps.loadWeather
        ? deps.loadWeather(report, userId).catch(() => null)
        : deps.generate === null
          ? Promise.resolve(null)
          : loadWeatherSentence(report, userId).catch(() => null),
    ]);
    return { items, pulses, weather };
  };
  const { items, pulses, weather } = await withDeadline(
    gather(),
    CONTEXT_DEADLINE_MS,
    'Brief context gathering',
  );

  const areas = budgetAreaLines(report.sections.albatross, pulses);
  const prose = await withDeadline(
    writeBriefProse(
      {
        firstName: contextFirstName() || null,
        kind: report.kind,
        now,
        timezone,
        items,
        calendar: report.sections.calendar ?? [],
        tasks: (report.sections.tasks ?? [])
          .filter((task) => !task.completedAt && typeof task.dueAt === 'number')
          .map((task) => ({ title: task.title, dueAt: task.dueAt ?? null })),
        areas: areas.map((area) => ({ name: area.name, line: area.line })),
        tomorrowIntent: report.sections.albatross?.dailyAlignment?.tomorrowIntent ?? null,
        weather,
      },
      { generate: deps.generate, userId },
    ),
    PROSE_DEADLINE_MS,
    'Brief prose generation',
  );

  const document = composeBudgetBriefDocument({ report, prose, areas, timezone });
  return { document, prose, areas };
}

// Writes the prose back into the stored edition: the lede becomes the
// narrative, each selected item keeps its line, and the deterministic HTML is
// rebuilt from the final sections.
export function finalizeBudgetReport(report: DailyReport, composed: ComposedBudgetBrief): DailyReport {
  const withLine = (items: DailyReportItem[] | undefined) =>
    (items ?? []).map((item) => {
      const line = composed.prose.lines[`${item.account}:${item.threadId}`];
      return line ? { ...item, line } : item;
    });
  const next: DailyReport = {
    ...report,
    narrative: composed.prose.lede || report.narrative,
    prose: { lede: composed.prose.lede, weekAhead: composed.prose.weekAhead, model: composed.prose.model },
    sections: {
      ...report.sections,
      answer: withLine(report.sections.answer),
      today: withLine(report.sections.today),
      know: withLine(report.sections.know),
    },
    document: composed.document,
    artifactStatus: 'ready',
    artifactSource: 'document-v2',
    model: composed.prose.model,
  };
  next.composition = compositionFromReport(next);
  next.html = buildNativeDailyReportArtifact(next, next.composition);
  return next;
}

export function dailyBriefEditionTitle(
  generatedAt: number,
  timeZone = getAiRequestContext().userTimezone || 'UTC',
): string {
  return dailyBriefEditionTitleAt(generatedAt, timeZone);
}
