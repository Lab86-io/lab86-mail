// One "generating" rule for every brief reader. Native uses the same rule
// (`DailyReport.isGenerating` in ProductModels.swift). An edition that the
// writer retries stays `ready` with `retrying: true`: it is readable, and the
// reader shows a short note instead of the progress animation.

export interface BriefGenerationState {
  status?: 'partial' | 'ready' | null;
  artifactStatus?: string | null;
  retrying?: boolean | null;
}

/** True while the edition is still being written and has nothing to read yet. */
export function isBriefEditionGenerating(report: BriefGenerationState | null | undefined): boolean {
  if (!report) return false;
  return (
    report.status === 'partial' ||
    report.artifactStatus === 'composing' ||
    report.artifactStatus === 'enriching'
  );
}

/** True when a readable edition waits for another writer attempt. */
export function isBriefEditionRetrying(report: BriefGenerationState | null | undefined): boolean {
  return Boolean(report?.retrying) && !isBriefEditionGenerating(report);
}

export const BRIEF_RETRY_NOTE = 'The writer could not finish this edition. It will try again shortly.';
