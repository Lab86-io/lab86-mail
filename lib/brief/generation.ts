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

/**
 * True when the row holds an edition that a reader can read. Only the `partial`
 * placeholder has nothing. A `composing` row saved its plain letter first.
 */
export function isBriefEditionReadable(report: BriefGenerationState | null | undefined): boolean {
  return Boolean(report) && report?.status !== 'partial';
}

/** True when a readable edition waits for another writer attempt. */
export function isBriefEditionRetrying(report: BriefGenerationState | null | undefined): boolean {
  return Boolean(report?.retrying) && !isBriefEditionGenerating(report);
}

export const BRIEF_RETRY_NOTE = 'The writer could not finish this edition. It will try again shortly.';

/** The quiet line while the page keeps the last edition and a new one has no text yet. */
export const BRIEF_NEW_EDITION_NOTE =
  'A new edition comes in about 3 minutes. You can read this edition until then.';
/** The quiet line while the page shows the plain letter of the new edition. */
export const BRIEF_PLAIN_LETTER_NOTE =
  'This is the plain letter of the new edition. The full edition comes in about 2 minutes.';

/** The text of an edition whose job ended with nothing written. */
export const BRIEF_EDITION_NOT_WRITTEN =
  'This edition could not be written. Write a new edition to try again.';

/** The quiet line while the page shows an older edition, because the newest has nothing in it. */
export const BRIEF_LAST_EDITION_FAILED_NOTE =
  'The last edition could not be written. You can read this edition or write a new one.';

/** True for a row that a failed job closed with nothing to read. An older edition is better. */
export function isBriefEditionEmptyFailure(report: { narrative?: unknown } | null | undefined): boolean {
  return report?.narrative === BRIEF_EDITION_NOT_WRITTEN;
}
