import { randomUUID } from 'node:crypto';
import { contextFirstName, getAiRequestContext, runWithAiRequestContext } from '../ai/context';
import { generateTextForCurrentUser, resolveAiRuntime } from '../ai/gateway';
import { BriefBudgetExhaustedError, currentBriefMeter } from '../brief/budget';
import { api, convexQuery } from '../hosted/convex';
import { prepareBriefContext } from '../narrative/service';
import { compositionFromReport } from '../shared/brief-composition';
import type { BriefDocumentV2 } from '../shared/brief-document';
import { normalizeBriefTimezone } from '../shared/brief-edition';
import {
  type BriefEditionKind,
  type DailyReport,
  type DailyReportArtifactError,
  type DailyReportArtifactErrorStage,
  type DailyReportItem,
  type DailyReportSinceLastEdition,
  MAX_ARTIFACT_ERROR_MESSAGE_CHARS,
  MAX_ARTIFACT_ERRORS,
  type Message,
} from '../shared/types';
import { getDailyReport, listDailyReports, saveDailyReport } from '../store/daily-reports';
import { getThreadMessages } from '../store/messages';
import { type AreaPulseRecord, budgetAreaLines } from './brief-areas';
import { type BudgetAreaLine, composeBudgetBriefDocument } from './brief-budget-document';
import { writeDailyEditorial } from './brief-editorial';
import { resolveBriefPlanTier } from './brief-plan';
import { type BriefProseItemInput, type BriefProseResult, writeBriefProse } from './brief-prose';
import type { BriefLane } from './brief-score';
import { briefSourceCoverage } from './brief-source-refresh';
import { resolveBriefTimezone } from './brief-timezone';
import { gatherBriefWeather, weatherSentence } from './brief-weather';
import { generateDailyReport } from './daily-report';
import { buildNativeDailyReportArtifact } from './report-artifact';

// Selection and bounded analysis -> prose -> editorial composition. The
// source document is also the complete fallback when design is unavailable.
// Deterministic HTML stays beside the v2 document for older clients.

// Limit selected input, leaving the writers time and output to finish.
const MAX_MSGS_PER_ITEM = 2;
const MAX_BODY_CHARS = 3000;
// The look back never reaches further than this when no previous edition
// exists, so a first brief does not list a month of completions.
const SINCE_FALLBACK_MS = 24 * 3600_000;
const SINCE_MAX_MS = 7 * 86_400_000;

// ---- Continuity across editions (brief round 2026-09-22) -------------------

type ItemKey = `${string}:${string}`;
function itemKey(item: Pick<DailyReportItem, 'account' | 'threadId'>): ItemKey {
  return `${item.account}:${item.threadId}`;
}

// The edition before this one: the newest stored report of any kind that is
// not the report being written and was generated earlier.
export async function findPreviousEdition(
  reportId: string,
  now: number,
  list: (limit: number) => Promise<DailyReport[]> = listDailyReports,
): Promise<DailyReport | null> {
  const reports = await list(4).catch(() => [] as DailyReport[]);
  return (
    reports
      .filter((report) => report._id !== reportId && report.generatedAt < now)
      .sort((a, b) => b.generatedAt - a.generatedAt)[0] ?? null
  );
}

// Copies firstSurfacedAt from the previous edition onto the items that are
// still in the brief, and stamps today's items with today's time.
export function carryOverItems(report: DailyReport, previous: DailyReport | null): DailyReport {
  const firstSeen = new Map<ItemKey, number>();
  if (previous) {
    const lanes = [
      ...(previous.sections.answer ?? []),
      ...(previous.sections.today ?? []),
      ...(previous.sections.know ?? []),
      ...(previous.sections.waiting ?? []),
    ];
    for (const item of lanes) {
      const at =
        typeof item.firstSurfacedAt === 'number' && Number.isFinite(item.firstSurfacedAt)
          ? item.firstSurfacedAt
          : previous.generatedAt;
      const key = itemKey(item);
      firstSeen.set(key, Math.min(firstSeen.get(key) ?? at, at));
    }
  }
  const stamp = (items: DailyReportItem[] | undefined) =>
    (items ?? []).map((item) => ({
      ...item,
      firstSurfacedAt: firstSeen.get(itemKey(item)) ?? report.generatedAt,
    }));
  return {
    ...report,
    sections: {
      ...report.sections,
      answer: stamp(report.sections.answer),
      today: stamp(report.sections.today),
      know: stamp(report.sections.know),
      waiting: stamp(report.sections.waiting),
    },
  };
}

export function carriedDaysFor(item: Pick<DailyReportItem, 'firstSurfacedAt'>, generatedAt: number): number {
  const first = item.firstSurfacedAt;
  if (typeof first !== 'number' || !Number.isFinite(first) || first >= generatedAt) return 0;
  return Math.floor((generatedAt - first) / 86_400_000);
}

export async function loadSinceLastEditionFromConvex(
  userId: string,
  since: number,
  query: <T>(fn: unknown, args: Record<string, unknown>) => Promise<T> = convexQuery,
): Promise<DailyReportSinceLastEdition> {
  const [completions, operations] = await Promise.all([
    query<any[]>((api as any).albatrossWork.completionsSince, { userId, since, limit: 12 }).catch(
      () => [] as any[],
    ),
    query<any[]>((api as any).operations.listRecent, { userId, limit: 60 }).catch(() => [] as any[]),
  ]);
  return {
    previousGeneratedAt: since,
    completions: (completions || []).map((row) => ({
      artifactKind: String(row.artifactKind || ''),
      artifactId: String(row.artifactId || ''),
      title: String(row.title || ''),
      areaId: row.areaId ? String(row.areaId) : undefined,
      completedAt: Number(row.completedAt || 0),
    })),
    // What Albatross did, newest first, each with the log row id so the
    // brief can offer Undo (FEATURES item 7).
    agentActions: (operations || [])
      .filter(
        (row) =>
          row.agent === 'ai' &&
          row.status === 'applied' &&
          Number(row.createdAt || 0) >= since &&
          row.summary,
      )
      .slice(0, 8)
      .map((row) => ({
        tool: String(row.tool || ''),
        surface: String(row.surface || ''),
        summary: String(row.summary || '').slice(0, 200),
        createdAt: Number(row.createdAt || 0),
        ...(row._id ? { operationId: String(row._id) } : {}),
        undoable: Boolean(row.inverse),
        ...(typeof row.reason === 'string' && row.reason.trim()
          ? { reason: row.reason.trim().slice(0, 200) }
          : {}),
        status: String(row.status),
      })),
  };
}

// The window the look back covers: since the previous edition, bounded to a
// week; one day when there is no previous edition.
export function sinceWindowStart(previous: DailyReport | null, now: number): number {
  if (!previous) return now - SINCE_FALLBACK_MS;
  return Math.max(previous.generatedAt, now - SINCE_MAX_MS);
}

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

export interface AgentReportInput {
  kind: BriefEditionKind;
  userId?: string | null;
  now?: number;
  reportId?: string;
  /** A retry over a published edition: skip the progress saves so the edition stays ready. */
  quiet?: boolean;
  /** A weekend edition without the know, waiting, task, and tool sections. */
  light?: boolean;
  /** The first edition after the first mailbox connects (FEATURES item 4). */
  first?: boolean;
  /**
   * Publish from the last 48 hours of mail and the next 7 days of calendar
   * with no model call. The writer upgrades the same edition in place later.
   */
  deterministic?: boolean;
}

export async function generateAgentReport(input: AgentReportInput): Promise<DailyReport> {
  // The dateline, the weather, and the week-ahead weekday names all read the
  // context timezone. A usable context value stands; when it is missing or
  // UTC-filler, resolve one from the user's synced calendars.
  const context = getAiRequestContext();
  const userTimezone = await resolveBriefTimezone(input.userId ?? context.userId, context.userTimezone);
  return runWithAiRequestContext({ ...context, userTimezone }, () => runAgentReport(input));
}

async function runAgentReport(input: AgentReportInput): Promise<DailyReport> {
  const reportId = input.reportId ?? randomUUID();
  // Fresh source observations precede selection; the editorial writer then
  // chooses a focused account from this refreshed evidence.
  // The deterministic first edition reads what the first sync stored; it
  // does not wait for a source refresh.
  const sourceChecks =
    input.userId && !input.deterministic
      ? await prepareBriefContext(input.userId).catch(() => [
          { source: 'source discovery', status: 'unavailable' as const },
        ])
      : [];
  const tier = await resolveBriefPlanTier(input.userId);

  let structured: DailyReport;
  try {
    structured = await generateDailyReport({
      kind: input.kind,
      includeCalendar: true,
      userId: input.userId,
      now: input.now,
      scope: input.deterministic ? 'first' : 'week',
      ...(input.deterministic ? { noModel: true } : {}),
      reportId,
      tier,
      silent: input.quiet === true,
    });
    if (sourceChecks.some((check) => check.status === 'unavailable'))
      structured.errors = [...(structured.errors || []), briefSourceCoverage(sourceChecks)];
    if (input.light) structured.light = true;
    if (input.first) structured.first = true;
    if (sourceChecks.length) structured.sourceChecks = sourceChecks.slice(0, 24);
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

  // Continuity: mark the items carried from the previous edition before the
  // prose is written, so the letter can say how long a thread has waited.
  const previous = await findPreviousEdition(reportId, structured.generatedAt);
  structured = carryOverItems(structured, previous);

  const composition = compositionFromReport(structured);
  const html = buildNativeDailyReportArtifact(structured, composition);
  if (!input.quiet)
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
  if (input.deterministic) generate = null;
  else
    try {
      await resolveAiRuntime({ userId: input.userId, speed: 'primary', feature: 'daily_brief_prose' });
    } catch (err) {
      availability = artifactError('ai_availability', err);
      generate = null;
    }

  try {
    const composed = await composeDailyBrief(structured, input.userId, { generate, previous });
    const report = finalizeBudgetReport(structured, composed);
    // A writer with no plan, key, or credits is recorded as an availability
    // error: the brief job reads it and publishes this edition as final.
    availability ??= composed.writerTerminalError
      ? artifactError('ai_availability', composed.writerTerminalError)
      : undefined;
    const settled = withEditionBudget(availability ? withArtifactError(report, availability) : report);
    await saveDailyReport(settled);
    return settled;
  } catch (err) {
    console.error('[agent-report] budget composition failed:', err);
    const fallback = withEditionBudget(
      withArtifactError(
        {
          ...structured,
          composition,
          html,
          artifactStatus: 'rendered',
          artifactSource: 'deterministic',
        },
        artifactError('document_v2', err),
      ),
    );
    await saveDailyReport(fallback);
    return fallback;
  }
}

// The edition budget record (FEATURES item 5): the meter of the running
// brief job, with the budget that ran out noted in the artifact errors.
export function withEditionBudget(report: DailyReport): DailyReport {
  const meter = currentBriefMeter();
  if (!meter) return report;
  const budget = meter.record(report.editorial?.mode !== 'generated');
  const next = { ...report, budget };
  return budget.exhausted
    ? withArtifactError(next, artifactError('document_v2', new BriefBudgetExhaustedError(budget.exhausted)))
    : next;
}

// ---- Budget composition ----------------------------------------------------

export interface ComposedBudgetBrief {
  document: BriefDocumentV2;
  prose: BriefProseResult;
  areas: BudgetAreaLine[];
  since?: DailyReportSinceLastEdition;
  editorial?: DailyReport['editorial'];
  layoutFailed?: boolean;
  /** The writer failed in a way another attempt cannot fix. Never persisted. */
  writerTerminalError?: Error;
  /** Ephemeral writer context; never persisted into the edition. */
  editorialEvidence?: Record<string, unknown>;
}

export interface ComposeBudgetBriefDeps {
  generate?: typeof generateTextForCurrentUser | null;
  loadMessages?: (account: string, threadId: string) => Promise<Message[]>;
  loadAreaPulses?: (userId: string) => Promise<AreaPulseRecord[]>;
  loadWeather?: (report: DailyReport, userId: string | null | undefined) => Promise<string | null>;
  loadSince?: (userId: string, since: number) => Promise<DailyReportSinceLastEdition>;
  previous?: DailyReport | null;
  now?: number;
}

// The items the prose describes. A light edition shows no know or waiting rows,
// so the writer does not spend a line on them.
function selectedItems(report: DailyReport): Array<{ item: DailyReportItem; lane: BriefLane | 'waiting' }> {
  const s = report.sections;
  return [
    ...(s.answer ?? []).map((item) => ({ item, lane: 'answer' as const })),
    ...(s.today ?? []).map((item) => ({ item, lane: 'today' as const })),
    ...(report.light ? [] : (s.know ?? []).map((item) => ({ item, lane: 'know' as const }))),
    ...(report.light ? [] : (s.waiting ?? []).map((item) => ({ item, lane: 'waiting' as const }))),
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
        carriedDays: carriedDaysFor(item, now),
        messages: messages
          .slice(-MAX_MSGS_PER_ITEM)
          .map((m) => ({ from: m.from, date: m.date ?? null, body: cleanBody(m) }))
          .filter((m) => m.body.length > 0),
      });
    }
    const sinceStart = sinceWindowStart(deps.previous ?? null, now);
    const [pulses, weather, since] = await Promise.all([
      userId
        ? (deps.loadAreaPulses ?? loadAreaPulsesFromConvex)(userId).catch(() => [] as AreaPulseRecord[])
        : Promise.resolve([] as AreaPulseRecord[]),
      deps.loadWeather
        ? deps.loadWeather(report, userId).catch(() => null)
        : deps.generate === null
          ? Promise.resolve(null)
          : loadWeatherSentence(report, userId).catch(() => null),
      userId
        ? (deps.loadSince ?? loadSinceLastEditionFromConvex)(userId, sinceStart).catch(
            (): DailyReportSinceLastEdition => ({
              previousGeneratedAt: sinceStart,
              completions: [],
              agentActions: [],
            }),
          )
        : Promise.resolve<DailyReportSinceLastEdition>({
            previousGeneratedAt: sinceStart,
            completions: [],
            agentActions: [],
          }),
    ]);
    return { items, pulses, weather, since };
  };
  const { items, pulses, weather, since } = await gather();

  const areas = budgetAreaLines(report.sections.albatross, pulses);
  const prose = await writeBriefProse(
    {
      firstName: contextFirstName() || null,
      kind: report.kind === 'morning' ? 'morning' : 'manual',
      now,
      timezone,
      items,
      calendar: report.sections.calendar ?? [],
      tasks: (report.sections.tasks ?? [])
        .filter((task) => !task.completedAt && typeof task.dueAt === 'number')
        .map((task) => ({ title: task.title, dueAt: task.dueAt ?? null })),
      areas: areas.map((area) => ({ name: area.name, line: area.line })),
      connectedEvidence: report.sections.mcp ?? [],
      tomorrowIntent: report.sections.albatross?.dailyAlignment?.tomorrowIntent ?? null,
      reflection: report.sections.albatross?.dailyAlignment?.reflection ?? null,
      weather,
      since: {
        previousGeneratedAt: deps.previous?.generatedAt ?? null,
        completed: since.completions.map((row) => row.title).filter(Boolean),
        agentActions: since.agentActions.map((row) => row.summary).filter(Boolean),
      },
    },
    { generate: deps.generate, userId },
  );

  // The look back is part of the letter: "What Albatross did" follows the lede.
  const document = composeBudgetBriefDocument({
    report: { ...report, sections: { ...report.sections, since } },
    prose,
    areas,
    timezone,
  });
  return {
    document,
    prose,
    areas,
    since,
    editorialEvidence: {
      ...Object.fromEntries(items.map((item) => [`thread:${item.key}`, item])),
      yesterday: { since, reflection: report.sections.albatross?.dailyAlignment?.reflection },
      'week-ahead': { calendar: report.sections.calendar, tasks: report.sections.tasks },
      lede: { weather, intention: report.sections.albatross?.dailyAlignment?.tomorrowIntent },
    },
  };
}

/** Selection supplies evidence; the editor authors the complete daily page. */
export async function composeDailyBrief(
  report: DailyReport,
  userId: string | null | undefined,
  deps: ComposeBudgetBriefDeps = {},
): Promise<ComposedBudgetBrief> {
  const composed = await composeBudgetBrief(report, userId, deps);
  const layout = await writeDailyEditorial(report, composed.document, {
    userId,
    generate: deps.generate,
    evidence: composed.editorialEvidence,
  });
  layout.editorial.plan.areas = composed.areas.map((area) => ({
    areaId: area.areaId.slice(0, 240),
    name: area.name.slice(0, 500),
    line: area.line.slice(0, 4000),
  }));
  return {
    ...composed,
    document: layout.document,
    editorial: layout.editorial,
    layoutFailed: layout.failed,
    ...(layout.terminalError ? { writerTerminalError: layout.terminalError } : {}),
  };
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
    prose: {
      lede: composed.prose.lede,
      weekAhead: composed.prose.weekAhead,
      yesterday: composed.prose.yesterday,
      model: composed.prose.model,
    },
    sections: {
      ...report.sections,
      answer: withLine(report.sections.answer),
      today: withLine(report.sections.today),
      know: withLine(report.sections.know),
      waiting: withLine(report.sections.waiting),
      ...(composed.since ? { since: composed.since } : {}),
    },
    document: composed.document,
    ...(composed.editorial ? { editorial: composed.editorial } : {}),
    artifactStatus: 'ready',
    artifactSource: 'document-v2',
    model: composed.prose.model,
  };
  next.composition = compositionFromReport(next);
  next.html = buildNativeDailyReportArtifact(next, next.composition);
  return composed.layoutFailed
    ? withArtifactError(
        next,
        artifactError(
          'document_v2',
          'The editorial writer could not compose this edition. The source layout is available.',
        ),
      )
    : next;
}
