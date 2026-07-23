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
