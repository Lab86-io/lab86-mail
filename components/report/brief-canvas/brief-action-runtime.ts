import type { BriefActionV2, BriefSourceRefV2 } from '@/lib/shared/brief-document';

export type BriefActionPayload = Record<string, unknown>;

export function payloadForBriefAction(action: BriefActionV2, ref?: BriefSourceRefV2): BriefActionPayload {
  const payload = { ...action.payload };
  if (!ref) return payload;
  if (ref.account && payload.account === undefined) payload.account = ref.account;
  switch (ref.kind) {
    case 'thread':
      if (payload.threadId === undefined) payload.threadId = ref.id;
      break;
    case 'task':
    case 'card':
      if (payload.cardId === undefined) payload.cardId = ref.id;
      break;
    case 'event':
      if (payload.eventId === undefined) payload.eventId = ref.id;
      break;
    case 'area':
      if (payload.areaId === undefined) payload.areaId = ref.id;
      break;
    case 'work':
      if (payload.workId === undefined) payload.workId = ref.id;
      break;
  }
  return payload;
}

export function briefActionReviewCopy(action: BriefActionV2, payload: BriefActionPayload) {
  const named = String(payload.title ?? payload.subject ?? '').trim();
  switch (action.action) {
    case 'rsvp_event':
      return {
        title: `Send a “${String(payload.status ?? 'response')}” RSVP?`,
        detail: named || 'This response will be sent to the event organizer.',
        confirm: 'Send RSVP',
      };
    case 'create_task':
      return {
        title: `Add${named ? ` “${named}”` : ' this task'}?`,
        detail: 'The task will be added to your task list.',
        confirm: 'Add task',
      };
    case 'create_document':
      return {
        title: `Create${named ? ` “${named}”` : ' this file'}?`,
        detail:
          payload.attachToReply === true
            ? 'Albatross will generate the file, attach an exported copy to a reply draft, and wait for your review.'
            : 'Albatross will generate an editable file from the grounded brief context.',
        confirm: payload.attachToReply === true ? 'Prepare file + draft' : 'Create file',
      };
    case 'create_event':
      return {
        title: `Add${named ? ` “${named}”` : ' this event'}?`,
        detail: 'The event will be created on your calendar.',
        confirm: 'Add event',
      };
    case 'draft_reply':
      return {
        title: `Open a reply${named ? ` for “${named}”` : ''}?`,
        detail: 'Nothing is sent until you review and send it.',
        confirm: 'Review draft',
      };
    case 'capture_intent':
      return {
        title: 'Capture this intent?',
        detail: String(payload.text ?? ''),
        confirm: 'Capture',
      };
    case 'answer_question':
      return {
        title: 'Submit this answer?',
        detail: String(payload.text ?? ''),
        confirm: 'Submit answer',
      };
    default:
      return {
        title: `Review ${action.label}`,
        detail: 'Review this action before applying it.',
        confirm: action.label,
      };
  }
}

// ---- Telemetry ---------------------------------------------------------------

export type BriefEventSurface = 'daily' | 'area';
export type BriefEventOutcome = 'done' | 'failed' | 'undone' | 'opened';

export interface BriefEventRequest {
  reportId?: string;
  surface: BriefEventSurface;
  regionId: string;
  action: string;
  ref: { kind: string; id: string; account?: string };
  outcome: BriefEventOutcome;
}

/**
 * Builds the `POST /api/brief/events` body for one settled action. Returns
 * null when the region or the item is unknown, so nothing half-formed posts.
 */
export function briefEventRequest(input: {
  reportId?: string | null;
  surface?: BriefEventSurface;
  regionId?: string | null;
  action: string;
  ref?: BriefSourceRefV2 | null;
  payload?: BriefActionPayload;
  outcome: BriefEventOutcome;
}): BriefEventRequest | null {
  const regionId = input.regionId?.trim();
  if (!regionId) return null;
  const ref = input.ref ?? refFromPayload(input.payload ?? {});
  if (!ref) return null;
  return {
    ...(input.reportId ? { reportId: input.reportId } : {}),
    surface: input.surface ?? 'daily',
    regionId,
    action: input.action,
    ref: { kind: ref.kind, id: ref.id, ...(ref.account ? { account: ref.account } : {}) },
    outcome: input.outcome,
  };
}

function refFromPayload(payload: BriefActionPayload): BriefSourceRefV2 | null {
  const text = (key: string) => {
    const value = payload[key];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };
  const account = text('account');
  if (text('threadId')) return { kind: 'thread', id: text('threadId')!, account };
  if (text('cardId')) return { kind: 'card', id: text('cardId')! };
  if (text('eventId')) return { kind: 'event', id: text('eventId')!, account };
  return null;
}

/** Fire-and-forget. A failure to post never reaches the action path. */
export function postBriefEvent(request: BriefEventRequest | null) {
  if (!request || typeof fetch !== 'function') return;
  try {
    fetch('/api/brief/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Telemetry is best effort.
  }
}
