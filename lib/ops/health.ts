import { isAiChatFeature } from '../ai/budget';

// The failure alarm (docs/ops-signals.md). The production model key was
// disabled from 2026-10-22 to 10-27. On 10-26 and 10-27, 1,628 of 2,146 model
// calls failed and nothing told the owner.
//
// The write path adds one to a small hourly bucket. A cron reads only the last
// two hours of buckets and one watch row for each kind. It never reads
// aiUsageEvents, so the alarm cost does not grow with the usage tables.
//
// Pure module: convex/opsHealth.ts and lib/notifications/ops-alarm.ts both
// import it, so it must not import server code.

export const OPS_HEALTH_KINDS = [
  'model:chat',
  'model:brief',
  'model:jev',
  'model:narrative',
  'model:other',
  'tool',
  'run',
  'brief_fallback',
] as const;
export type OpsHealthKind = (typeof OPS_HEALTH_KINDS)[number];

export const OPS_ERROR_CLASSES = [
  'auth',
  'credit',
  'rate_limit',
  'timeout',
  'server',
  'parse',
  'network',
  'budget',
  'stopped',
  'unknown',
  'other',
] as const;
export type OpsErrorClass = (typeof OPS_ERROR_CLASSES)[number];

export const OPS_HOUR_MS = 3_600_000;
/**
 * Each kind and hour has this many rows. A random row takes each write, so a
 * burst of model calls does not make the usage mutation conflict with itself.
 */
export const OPS_HEALTH_SHARDS = 4;
/** The hours that one watch row keeps: "yesterday", and a little more. */
export const OPS_HISTORY_MS = 50 * OPS_HOUR_MS;
/** The newest two hours of rows, with all shards. A limit on the one read of the cron. */
export const OPS_WINDOW_ROW_LIMIT = OPS_HEALTH_KINDS.length * OPS_HEALTH_SHARDS * 2;
/** An incident stays open this long, so a short improvement does not send two more mails. */
export const OPS_MIN_INCIDENT_MS = 30 * 60_000;
/** A run that stopped between its claim and its mail loses the claim after this time. */
export const OPS_CLAIM_LEASE_MS = 10 * 60_000;

export interface OpsKindPolicy {
  label: string;
  /** The incident opens at this share of failed calls. */
  failureRate: number;
  /** Calls in the window before the failure rate counts. */
  minCalls: number;
  /** Hours with no successful call before the silence rule fires. Null: no silence rule. */
  silenceHours: number | null;
  /** Calls in the earlier hours that make silence unusual. */
  minEarlierCalls: number;
  /** No call at all is normal here (users can be idle). Only failed calls make silence an incident. */
  quietIsNormal: boolean;
}

// Normal failure is far below these rates: 9 of 3,854 model calls after the
// key came back. The silence hours fit the schedule of each group: the brief
// runs once a day, and chat waits for a person.
export const OPS_POLICY: Record<OpsHealthKind, OpsKindPolicy> = {
  'model:chat': {
    label: 'Chat agent model calls',
    failureRate: 0.5,
    minCalls: 5,
    silenceHours: 24,
    minEarlierCalls: 1,
    quietIsNormal: true,
  },
  'model:brief': {
    label: 'Brief model calls',
    failureRate: 0.25,
    minCalls: 5,
    silenceHours: 28,
    minEarlierCalls: 3,
    quietIsNormal: false,
  },
  'model:jev': {
    label: 'Jev model calls',
    failureRate: 0.25,
    minCalls: 10,
    silenceHours: 8,
    minEarlierCalls: 10,
    quietIsNormal: false,
  },
  'model:narrative': {
    label: 'Narrative model calls',
    failureRate: 0.25,
    minCalls: 10,
    silenceHours: 12,
    minEarlierCalls: 3,
    quietIsNormal: false,
  },
  'model:other': {
    label: 'Other model calls',
    failureRate: 0.25,
    minCalls: 10,
    silenceHours: 24,
    minEarlierCalls: 1,
    quietIsNormal: true,
  },
  tool: {
    label: 'Agent tool calls',
    failureRate: 0.5,
    minCalls: 8,
    silenceHours: null,
    minEarlierCalls: 0,
    quietIsNormal: true,
  },
  run: {
    label: 'Albatross runs',
    failureRate: 0.5,
    minCalls: 3,
    silenceHours: null,
    minEarlierCalls: 0,
    quietIsNormal: true,
  },
  brief_fallback: {
    label: 'Brief editions',
    failureRate: 0.5,
    minCalls: 2,
    silenceHours: null,
    minEarlierCalls: 0,
    quietIsNormal: true,
  },
};

/** The start of the UTC hour of a time. */
export function opsHourStart(ts: number) {
  return Math.floor(ts / OPS_HOUR_MS) * OPS_HOUR_MS;
}

/** The UTC day of a time, "2026-10-26". */
export function opsDay(ts: number) {
  return new Date(ts).toISOString().slice(0, 10);
}

/** The group of a model feature. An unknown feature goes to `model:other`, so it still counts. */
export function opsModelKind(feature: string): OpsHealthKind {
  if (isAiChatFeature(feature) || feature.startsWith('albatross_step')) return 'model:chat';
  if (feature.startsWith('daily_brief') || feature.startsWith('daily_report') || feature.startsWith('brief_'))
    return 'model:brief';
  if (feature.startsWith('jev_')) return 'model:jev';
  if (feature.startsWith('narrative_')) return 'model:narrative';
  return 'model:other';
}

const ERROR_CLASS_RULES: ReadonlyArray<readonly [OpsErrorClass, RegExp]> = [
  // An abort from a time limit says so. This rule must come before `stopped`.
  ['timeout', /time(d)?.?out|deadline/i],
  // A person stopped the call, or closed the page. The provider did not fail it.
  ['stopped', /stopped before it finished|\baborterror\b|\bwas aborted\b/i],
  ['budget', /edition used its|\bbudget\b/i],
  [
    'auth',
    /user not found|unauthori[sz]ed|forbidden|invalid api key|no auth|not_configured|api key|\b401\b|\b403\b/i,
  ],
  ['credit', /insufficient|\bcredits?\b|payment required|\b402\b/i],
  ['rate_limit', /rate.?limit|too many requests|\b429\b/i],
  ['network', /fetch failed|network|econn|enotfound|socket/i],
  ['parse', /invalid_response|parse|schema|validation|no object generated|incomplete/i],
  ['server', /overloaded|bad gateway|internal server|service unavailable|\(provider\)|\b5\d\d\b/i],
];

/**
 * A fixed class for an error text. The rollups and the mail hold only the
 * class, so no provider text or model output reaches them.
 */
export function classifyOpsError(error: string | null | undefined): OpsErrorClass {
  const text = (error || '').slice(0, 500);
  for (const [errorClass, pattern] of ERROR_CLASS_RULES) if (pattern.test(text)) return errorClass;
  return 'other';
}

/** A class that another writer sent, kept only when it is one of ours or a short plain name. */
export function cleanOpsErrorClass(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(value) ? value : null;
}

/** What one model call adds to its bucket. Null: a stopped call is not a failure and not a success. */
export function modelCallOutcome(ok: boolean, error?: string) {
  if (ok) return { ok: true as const };
  const errorClass = classifyOpsError(error);
  return errorClass === 'stopped' ? null : { ok: false as const, errorClass };
}

/** What a finished tool call adds. A rejected call goes to the tool rollup only: nothing broke. */
export function toolCallOutcome(input: { status: string; errorClass?: unknown; error?: string }) {
  if (input.status === 'succeeded') return { ok: true as const, errorClass: 'none' };
  if (input.status === 'rejected')
    return { ok: null, errorClass: cleanOpsErrorClass(input.errorClass) ?? 'rejected' };
  if (input.status === 'unknown')
    return { ok: false as const, errorClass: cleanOpsErrorClass(input.errorClass) ?? 'unknown' };
  return {
    ok: false as const,
    errorClass: cleanOpsErrorClass(input.errorClass) ?? classifyOpsError(input.error),
  };
}

export interface OpsBucketRow {
  hourStart: number;
  kind: string;
  ok: number;
  failed: number;
  lastErrorClass?: string;
  lastFailedAt?: number;
  lastOkAt?: number;
}

export interface OpsHourCount {
  hour: number;
  ok: number;
  failed: number;
}

export type OpsIncidentReason = 'failure_rate' | 'silence';

export interface OpsIncident {
  reason: OpsIncidentReason;
  openedAt: number;
  /** The counts of the window when the mail was written. */
  ok: number;
  failed: number;
  errorClass?: string;
  /** The opening mail went out. */
  openedSentAt?: number;
  /** The group is healthy again. The recovery mail is due. */
  recoveredAt?: number;
  /** A run holds this notice and sends its mail now. */
  claimedAt?: number;
}

export interface OpsWatchState {
  hours: OpsHourCount[];
  lastOkAt?: number;
  incident?: OpsIncident;
}

export type OpsNoticeType = 'opened' | 'recovered';

export interface OpsNotice {
  kind: OpsHealthKind;
  type: OpsNoticeType;
  reason: OpsIncidentReason;
  ok: number;
  failed: number;
  errorClass?: string;
  openedAt: number;
  lastOkAt?: number;
}

export interface OpsWindow {
  ok: number;
  failed: number;
  errorClass?: string;
  lastOkAt?: number;
}

/** Sums the shards of one kind. The class of the newest failure wins. */
export function opsWindow(rows: readonly OpsBucketRow[]): OpsWindow {
  let ok = 0;
  let failed = 0;
  let newestFailure = -1;
  let errorClass: string | undefined;
  let lastOkAt: number | undefined;
  for (const row of rows) {
    ok += row.ok;
    failed += row.failed;
    if (row.lastErrorClass && (row.lastFailedAt ?? 0) > newestFailure) {
      newestFailure = row.lastFailedAt ?? 0;
      errorClass = row.lastErrorClass;
    }
    if (row.lastOkAt !== undefined) lastOkAt = Math.max(lastOkAt ?? 0, row.lastOkAt);
  }
  return { ok, failed, ...(errorClass ? { errorClass } : {}), ...(lastOkAt ? { lastOkAt } : {}) };
}

/** The hour counts after this run: the fresh hours replace their old counts. Idempotent. */
export function mergeOpsHours(
  hours: readonly OpsHourCount[],
  rows: readonly OpsBucketRow[],
  now: number,
): OpsHourCount[] {
  const merged = new Map(hours.map((entry) => [entry.hour, entry]));
  const fresh = new Map<number, OpsHourCount>();
  for (const row of rows) {
    const entry = fresh.get(row.hourStart) ?? { hour: row.hourStart, ok: 0, failed: 0 };
    fresh.set(row.hourStart, { ...entry, ok: entry.ok + row.ok, failed: entry.failed + row.failed });
  }
  for (const [hour, entry] of fresh) merged.set(hour, entry);
  return [...merged.values()]
    .filter((entry) => entry.hour >= now - OPS_HISTORY_MS)
    .sort((a, b) => a.hour - b.hour);
}

function failureRateOf(window: Pick<OpsWindow, 'ok' | 'failed'>) {
  const calls = window.ok + window.failed;
  return calls ? window.failed / calls : 0;
}

/**
 * The rate rule needs no successful call. A disabled key gives failures only,
 * so a bucket with no `ok` must still open an incident: 15 of 15 is a 100% rate.
 */
export function breachesFailureRate(policy: OpsKindPolicy, window: Pick<OpsWindow, 'ok' | 'failed'>) {
  return window.ok + window.failed >= policy.minCalls && failureRateOf(window) >= policy.failureRate;
}

/**
 * The silence rule: the group had calls in the earlier hours and has no
 * successful call now. A group with only failed calls has no `lastOkAt`, and
 * that also counts as silence.
 */
export function breachesSilence(
  policy: OpsKindPolicy,
  state: Pick<OpsWatchState, 'hours' | 'lastOkAt'>,
  now: number,
) {
  if (policy.silenceHours === null) return false;
  const since = now - policy.silenceHours * OPS_HOUR_MS;
  if (state.lastOkAt !== undefined && state.lastOkAt >= since) return false;
  const earlierCalls = state.hours
    .filter((entry) => entry.hour < since)
    .reduce((sum, entry) => sum + entry.ok + entry.failed, 0);
  if (earlierCalls < Math.max(1, policy.minEarlierCalls)) return false;
  if (!policy.quietIsNormal) return true;
  return state.hours.some((entry) => entry.hour + OPS_HOUR_MS > since && entry.failed > 0);
}

/** Healthy enough to close an incident: the rate is well below the rule that opens one. */
function isRecovered(policy: OpsKindPolicy, window: OpsWindow) {
  return window.ok >= 1 && failureRateOf(window) < policy.failureRate / 2;
}

export interface OpsEvaluation {
  state: OpsWatchState;
  notice: OpsNotice | null;
}

/**
 * One run for one kind: the next state, and the notice to send. A notice sets
 * `claimedAt`, so a run that starts before the mail goes out does not send it
 * too. Only the group's own state decides, so a restart changes nothing.
 */
export function evaluateOpsKind(
  kind: OpsHealthKind,
  previous: OpsWatchState,
  rows: readonly OpsBucketRow[],
  now: number,
): OpsEvaluation {
  const policy = OPS_POLICY[kind];
  const window = opsWindow(rows);
  const hours = mergeOpsHours(previous.hours, rows, now);
  const lastOkAt =
    window.lastOkAt === undefined ? previous.lastOkAt : Math.max(previous.lastOkAt ?? 0, window.lastOkAt);
  const history = { hours, ...(lastOkAt === undefined ? {} : { lastOkAt }) };
  const counts = {
    ok: window.ok,
    failed: window.failed,
    ...(window.errorClass ? { errorClass: window.errorClass } : {}),
  };
  const reason: OpsIncidentReason | null = breachesFailureRate(policy, window)
    ? 'failure_rate'
    : breachesSilence(policy, history, now)
      ? 'silence'
      : null;

  let incident = previous.incident;
  if (!incident) {
    if (!reason) return { state: history, notice: null };
    incident = { reason, openedAt: now, ...counts };
  } else if (reason) {
    // A second cause of the same incident does not open a new one. A new
    // breach also takes back a recovery that has no mail yet.
    const { recoveredAt: _recoveredAt, ...open } = incident;
    incident = incident.openedSentAt ? open : { ...open, reason, ...counts };
  } else if (!incident.recoveredAt && now - incident.openedAt >= OPS_MIN_INCIDENT_MS) {
    if (isRecovered(policy, window)) {
      // The owner never heard of it, so there is nothing to take back.
      if (!incident.openedSentAt) return { state: history, notice: null };
      incident = { ...incident, recoveredAt: now };
    }
  }

  const claimFree = !incident.claimedAt || now - incident.claimedAt >= OPS_CLAIM_LEASE_MS;
  const type: OpsNoticeType | null = !incident.openedSentAt
    ? 'opened'
    : incident.recoveredAt
      ? 'recovered'
      : null;
  if (!type || !claimFree) return { state: { ...history, incident }, notice: null };
  const claimed = { ...incident, claimedAt: now };
  return {
    state: { ...history, incident: claimed },
    notice: {
      kind,
      type,
      reason: claimed.reason,
      ok: claimed.ok,
      failed: claimed.failed,
      ...(claimed.errorClass ? { errorClass: claimed.errorClass } : {}),
      openedAt: claimed.openedAt,
      ...(lastOkAt === undefined ? {} : { lastOkAt }),
    },
  };
}

/** A stable text of a state, to skip a write that changes nothing. The key order of a row can differ. */
export function opsStateKey(state: OpsWatchState) {
  const { hours, lastOkAt, incident } = state;
  return JSON.stringify([
    hours.map((entry) => [entry.hour, entry.ok, entry.failed]),
    lastOkAt ?? null,
    incident
      ? [
          incident.reason,
          incident.openedAt,
          incident.ok,
          incident.failed,
          incident.errorClass ?? null,
          incident.openedSentAt ?? null,
          incident.recoveredAt ?? null,
          incident.claimedAt ?? null,
        ]
      : null,
  ]);
}

/** The state after the mail of a notice went out. */
export function settleOpsNotice(state: OpsWatchState, type: OpsNoticeType, now: number): OpsWatchState {
  if (!state.incident) return state;
  if (type === 'recovered') {
    const { incident: _incident, ...rest } = state;
    return rest;
  }
  const { claimedAt: _claimedAt, ...incident } = state.incident;
  return { ...state, incident: { ...incident, openedSentAt: now } };
}

/** The state after a mail failed: the next run sends the notice again. */
export function releaseOpsNotice(state: OpsWatchState): OpsWatchState {
  if (!state.incident) return state;
  const { claimedAt: _claimedAt, ...incident } = state.incident;
  return { ...state, incident };
}
