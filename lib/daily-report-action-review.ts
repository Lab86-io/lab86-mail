export type DailyReportActionPayload = {
  title?: string;
  subject?: string;
  completed?: boolean;
  status?: string;
};

export type DailyReportActionReview = {
  message: string;
  destructive: boolean;
};

export function dailyReportActionReview(
  action: string | undefined,
  payload: DailyReportActionPayload,
): DailyReportActionReview | null {
  switch (action) {
    case 'toggle_task':
      return {
        message: payload.completed
          ? `Mark “${payload.title || 'this task'}” complete?`
          : `Reopen “${payload.title || 'this task'}”?`,
        destructive: false,
      };
    case 'dismiss_task':
      return {
        message: `Remove “${payload.title || 'this task'}” from future briefs?`,
        destructive: true,
      };
    case 'resolve_thread':
      return {
        message: `Mark “${payload.subject || 'this thread'}” resolved and remove it from future briefs?`,
        destructive: true,
      };
    case 'dismiss_thread':
      return {
        message: `Remove “${payload.subject || 'this conversation'}” from future briefs?`,
        destructive: true,
      };
    case 'create_task':
      return {
        message: `Add “${payload.title || 'this task'}” to your tasks?`,
        destructive: false,
      };
    case 'create_document':
      return {
        message: `Create “${payload.title || 'this file'}” in Albatross?`,
        destructive: false,
      };
    case 'archive_thread':
      return {
        message: `Archive “${payload.subject || 'this conversation'}” and remove it from future briefs?`,
        destructive: true,
      };
    case 'rsvp_event':
      return {
        message: `Send a “${payload.status || 'response'}” RSVP for this event?`,
        destructive: false,
      };
    case 'create_event':
      return {
        message: `Add “${payload.title || 'this event'}” to your calendar?`,
        destructive: false,
      };
    case 'open_url':
      return {
        message: 'Open this external link in a new tab?',
        destructive: false,
      };
    default:
      return null;
  }
}

export function confirmDailyReportAction(
  action: string | undefined,
  payload: DailyReportActionPayload,
  confirm: (message: string) => boolean,
): boolean {
  const review = dailyReportActionReview(action, payload);
  return review ? confirm(review.message) : true;
}

/** The tallest a brief may ask to be. Roughly forty screens. */
export const MAX_ARTIFACT_FRAME_HEIGHT = 40_000;
/** What the frame stands at before the artifact has measured itself. */
export const DEFAULT_ARTIFACT_FRAME_HEIGHT = 640;

/**
 * How tall to draw the embedded brief.
 *
 * Embedded in Today the artifact flows in the page scroll, so it reports its own
 * height. That number crosses from model-authored, mailbox-derived HTML, so it
 * is a value to distrust: rubbish falls back to the default, and a number large
 * enough to break the page is clamped rather than obeyed.
 */
export function artifactFrameHeight(raw: unknown): number {
  const height = Number(raw);
  if (!Number.isFinite(height) || height <= 0) return DEFAULT_ARTIFACT_FRAME_HEIGHT;
  return Math.min(Math.ceil(height), MAX_ARTIFACT_FRAME_HEIGHT);
}
