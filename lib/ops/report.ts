import { BRIEF_STAGES, type BriefStage } from '../brief/stages';
import { OPS_HEALTH_KINDS, OPS_HOUR_MS, OPS_POLICY, type OpsHealthKind } from './health';
import { mergeSpeedBuckets, RUN_SPEED_METRICS, speedDayBefore, speedPercentile } from './speed';

// The numbers of scripts/ops-report.ts (docs/ops-signals.md). The rows hold
// counts, fixed names, and tool names, so this report cannot print personal
// data. The hand-run script only reads.

export interface ReportBucket {
  hourStart: number;
  kind: string;
  ok: number;
  failed: number;
  lastErrorClass?: string;
}

export interface ReportToolRow {
  day: string;
  toolName: string;
  errorClass: string;
  count: number;
}

export interface ReportSpeedRow {
  day: string;
  metric: string;
  surface: string;
  formFactor: string;
  count: number;
  sum: number;
  buckets: number[];
}

export interface ReportBriefSummary {
  editions: number;
  truncated: boolean;
  fallbackRate: number;
  stages: Partial<Record<BriefStage, { editions: number; p50: number; p90: number }>>;
}

export interface OpsReportData {
  buckets: ReportBucket[];
  tools: ReportToolRow[];
  speed: ReportSpeedRow[];
  briefDay: ReportBriefSummary;
  briefWeek: ReportBriefSummary;
}

export interface GroupLine {
  kind: OpsHealthKind;
  label: string;
  calls: number;
  failed: number;
  failureRate: number;
  errorClass: string | null;
}

export interface ToolLine {
  toolName: string;
  calls: number;
  failed: number;
  failureRate: number;
  classes: Array<{ errorClass: string; count: number }>;
}

export interface SpeedLine {
  metric: string;
  surface: string;
  formFactor: string;
  count: number;
  p50: number | null;
  p75: number | null;
}

export interface OpsReportWindow {
  title: string;
  groups: GroupLine[];
  tools: ToolLine[];
  runs: SpeedLine[];
  web: SpeedLine[];
  brief: ReportBriefSummary;
}

/** A class that is not a failure: `none` is a success, and `rejected` is a refused call. */
const NOT_FAILED_CLASSES = new Set(['none', 'rejected']);

function groupLines(buckets: readonly ReportBucket[], since: number): GroupLine[] {
  return OPS_HEALTH_KINDS.map((kind) => {
    const rows = buckets.filter((row) => row.kind === kind && row.hourStart >= since);
    const ok = rows.reduce((sum, row) => sum + row.ok, 0);
    const failed = rows.reduce((sum, row) => sum + row.failed, 0);
    const calls = ok + failed;
    const newest = rows.filter((row) => row.lastErrorClass).sort((a, b) => b.hourStart - a.hourStart)[0];
    return {
      kind,
      label: OPS_POLICY[kind].label,
      calls,
      failed,
      failureRate: calls ? failed / calls : 0,
      errorClass: newest?.lastErrorClass ?? null,
    };
  });
}

function toolLines(rows: readonly ReportToolRow[], sinceDay: string): ToolLine[] {
  const byTool = new Map<string, Map<string, number>>();
  for (const row of rows) {
    if (row.day < sinceDay) continue;
    const classes = byTool.get(row.toolName) ?? new Map<string, number>();
    classes.set(row.errorClass, (classes.get(row.errorClass) ?? 0) + row.count);
    byTool.set(row.toolName, classes);
  }
  return [...byTool.entries()]
    .map(([toolName, classes]) => {
      const entries = [...classes.entries()].map(([errorClass, count]) => ({ errorClass, count }));
      const calls = entries.reduce((sum, entry) => sum + entry.count, 0);
      const failedEntries = entries.filter((entry) => !NOT_FAILED_CLASSES.has(entry.errorClass));
      const failed = failedEntries.reduce((sum, entry) => sum + entry.count, 0);
      return {
        toolName,
        calls,
        failed,
        failureRate: calls ? failed / calls : 0,
        classes: entries.filter((entry) => entry.errorClass !== 'none').sort((a, b) => b.count - a.count),
      };
    })
    .sort((a, b) => b.failed - a.failed || b.calls - a.calls || a.toolName.localeCompare(b.toolName));
}

function speedLines(rows: readonly ReportSpeedRow[], sinceDay: string): SpeedLine[] {
  const merged = new Map<string, ReportSpeedRow>();
  for (const row of rows) {
    if (row.day < sinceDay) continue;
    const key = `${row.surface}|${row.metric}|${row.formFactor}`;
    const previous = merged.get(key);
    merged.set(
      key,
      previous
        ? {
            ...previous,
            count: previous.count + row.count,
            sum: previous.sum + row.sum,
            buckets: mergeSpeedBuckets(previous.buckets, row.buckets),
          }
        : row,
    );
  }
  return [...merged.values()]
    .map((row) => ({
      metric: row.metric,
      surface: row.surface,
      formFactor: row.formFactor,
      count: row.count,
      p50: speedPercentile(row.buckets, 0.5),
      p75: speedPercentile(row.buckets, 0.75),
    }))
    .sort(
      (a, b) =>
        a.surface.localeCompare(b.surface) ||
        a.metric.localeCompare(b.metric) ||
        a.formFactor.localeCompare(b.formFactor),
    );
}

/**
 * The two windows. Hourly rows cut at the exact time. Daily rows cut at a UTC
 * day, so "24 hours" reads today and yesterday, and "7 days" reads 8 UTC days.
 */
export function buildOpsReport(data: OpsReportData, now: number): OpsReportWindow[] {
  const windows = [
    { title: 'Last 24 hours', hours: 24, days: 1, brief: data.briefDay },
    { title: 'Last 7 days', hours: 24 * 7, days: 7, brief: data.briefWeek },
  ];
  return windows.map(({ title, hours, days, brief }) => {
    const sinceDay = speedDayBefore(now, days);
    const speed = speedLines(data.speed, sinceDay);
    const isRun = (line: SpeedLine) => (RUN_SPEED_METRICS as readonly string[]).includes(line.metric);
    return {
      title,
      groups: groupLines(data.buckets, Math.floor(now / OPS_HOUR_MS) * OPS_HOUR_MS - hours * OPS_HOUR_MS),
      tools: toolLines(data.tools, sinceDay),
      runs: speed.filter(isRun),
      web: speed.filter((line) => !isRun(line)),
      brief,
    };
  });
}

function percent(rate: number) {
  return `${(rate * 100).toFixed(1)}%`;
}

function ms(value: number | null) {
  if (value === null) return '-';
  return value >= 10_000 ? `${(value / 1000).toFixed(1)} s` : `${value} ms`;
}

/** CLS is stored as CLS × 1000 and prints as CLS. */
function speedValue(metric: string, value: number | null) {
  if (metric === 'CLS') return value === null ? '-' : (value / 1000).toFixed(3);
  return ms(value);
}

const RUN_LABELS: Record<string, string> = {
  run_queue: 'queue',
  run_first_visible: 'first visible',
  run_longest_silence: 'longest silence',
};

function formatWindow(window: OpsReportWindow) {
  const lines = [`== ${window.title} ==`, '', 'Failure rate by group'];
  for (const group of window.groups)
    lines.push(
      `  ${group.label}: ${group.calls} calls, ${percent(group.failureRate)} failed${
        group.errorClass ? `, last class ${group.errorClass}` : ''
      }`,
    );
  lines.push('', 'Tool failure rate by tool and class');
  if (!window.tools.length) lines.push('  No tool calls.');
  for (const tool of window.tools) {
    const classes = tool.classes.map((entry) => `${entry.errorClass} ${entry.count}`).join(', ');
    lines.push(
      `  ${tool.toolName}: ${tool.calls} calls, ${percent(tool.failureRate)} failed${classes ? ` (${classes})` : ''}`,
    );
  }
  lines.push('', 'Run latency');
  if (!window.runs.length) lines.push('  No finished runs.');
  for (const run of window.runs)
    lines.push(
      `  ${RUN_LABELS[run.metric] ?? run.metric}: p50 ${ms(run.p50)}, p75 ${ms(run.p75)}, ${run.count} runs`,
    );
  lines.push('', 'Brief stages');
  lines.push(
    `  ${window.brief.editions} editions${window.brief.truncated ? ' (newest 2,000 only)' : ''}, ${percent(window.brief.fallbackRate)} fallback`,
  );
  for (const stage of BRIEF_STAGES) {
    const times = window.brief.stages[stage];
    if (times?.editions)
      lines.push(`  ${stage}: p50 ${ms(times.p50)}, p90 ${ms(times.p90)}, ${times.editions} editions`);
  }
  lines.push('', 'Web speed by surface');
  if (!window.web.length) lines.push('  No web samples.');
  for (const web of window.web)
    lines.push(
      `  ${web.surface} ${web.metric} ${web.formFactor}: p50 ${speedValue(web.metric, web.p50)}, p75 ${speedValue(web.metric, web.p75)}, ${web.count} samples`,
    );
  return lines.join('\n');
}

export function formatOpsReport(windows: readonly OpsReportWindow[]) {
  return windows.map(formatWindow).join('\n\n');
}

type PageQuery = <T>(ref: any, args: Record<string, unknown>) => Promise<T>;

async function allPages<T>(
  query: PageQuery,
  ref: unknown,
  args: Record<string, unknown>,
  maxPages = 200,
): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const result: { rows: T[]; cursor: string; isDone: boolean } = await query(ref, { ...args, cursor });
    rows.push(...result.rows);
    if (result.isDone) break;
    cursor = result.cursor;
  }
  return rows;
}

/** Reads the rows for both windows through Convex queries. Nothing here writes. */
export async function loadOpsReportData(
  query: PageQuery,
  refs: { buckets: unknown; tools: unknown; speed: unknown; brief: unknown },
  now: number,
): Promise<OpsReportData> {
  const weekStart = Math.floor(now / OPS_HOUR_MS) * OPS_HOUR_MS - 24 * 7 * OPS_HOUR_MS;
  const sinceDay = speedDayBefore(now, 7);
  const [buckets, tools, speed, briefDay, briefWeek] = await Promise.all([
    allPages<ReportBucket>(query, refs.buckets, { since: weekStart }),
    allPages<ReportToolRow>(query, refs.tools, { sinceDay }),
    allPages<ReportSpeedRow>(query, refs.speed, { sinceDay }),
    query<ReportBriefSummary>(refs.brief, { since: now - 24 * OPS_HOUR_MS }),
    query<ReportBriefSummary>(refs.brief, { since: now - 24 * 7 * OPS_HOUR_MS }),
  ]);
  return { buckets, tools, speed, briefDay, briefWeek };
}
