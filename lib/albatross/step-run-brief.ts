// The Brief trigger for step runs. After the morning edition publishes, the
// server tries the current steps of the Work items the edition features. The
// tomorrow plan's Work comes first (the user chose it last night), then the
// active Albatrosses. The automatic-trigger rules apply: the switch, the
// "Work on steps by itself" order, agent-only steps, one run per step.

import type { AlbatrossDailyReportContext } from './daily-report';
import { startAutomaticRuns } from './step-run-start';

/** The Work ids an edition features, in priority order, without repeats. */
export function featuredWorkIds(context: Partial<AlbatrossDailyReportContext> | null | undefined): string[] {
  const ids = [
    ...(context?.dailyAlignment?.work || []).map((work) => work.id),
    ...(context?.activeIntents || []).map((intent) => intent.id),
  ].filter((id): id is string => typeof id === 'string' && id.length > 0);
  return [...new Set(ids)];
}

/** Start the Brief's runs. Never throws: the Brief never waits on or fails for a run. */
export async function startBriefStepRuns(
  userId: string,
  edition: string | undefined,
  report: { sections?: { albatross?: Partial<AlbatrossDailyReportContext> | null } } | null | undefined,
  start: typeof startAutomaticRuns = startAutomaticRuns,
) {
  if (edition !== 'morning') return { started: [] as string[] };
  const workIds = featuredWorkIds(report?.sections?.albatross);
  if (!workIds.length) return { started: [] as string[] };
  try {
    return await start({ userId, workIds, trigger: 'brief' });
  } catch {
    console.error('[brief jobs] step runs failed to start', userId);
    return { started: [] as string[] };
  }
}
