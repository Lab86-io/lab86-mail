// The stages of an edition job, for briefEditionTelemetry. Pure module:
// convex/dailyReports.ts and the brief meter both import it.

export const BRIEF_STAGES = ['queued', 'sources', 'composition', 'prose', 'editorial', 'save'] as const;
export type BriefStage = (typeof BRIEF_STAGES)[number];
export type BriefStageTimes = Partial<Record<BriefStage, number>>;

/** The sum of two stage maps, in whole milliseconds. Undefined when both are empty. */
export function addBriefStages(
  a: BriefStageTimes | null | undefined,
  b: BriefStageTimes | null | undefined,
): BriefStageTimes | undefined {
  const sum: BriefStageTimes = {};
  for (const stage of BRIEF_STAGES) {
    const value = (a?.[stage] ?? 0) + (b?.[stage] ?? 0);
    if (a?.[stage] !== undefined || b?.[stage] !== undefined) sum[stage] = Math.round(value);
  }
  return Object.keys(sum).length ? sum : undefined;
}
