export const BRIEF_ACTION_TIERS = {
  // `steer_item` (FEATURES item 8) carries payload.mode: not_for_me,
  // less_from_sender, or keep_showing. `undo_operation` (item 7) reverses one
  // logged operation by payload.operationId.
  immediate: [
    'toggle_task',
    'dismiss_task',
    'resolve_thread',
    'dismiss_thread',
    'archive_thread',
    'steer_item',
    'undo_operation',
    // The weekly review's Defer (FEATURES item 9): a task due date or a snooze.
    'defer_task',
    'defer_thread',
  ],
  review: [
    'rsvp_event',
    'create_task',
    'create_event',
    'create_document',
    'draft_reply',
    'capture_intent',
    'answer_question',
  ],
  navigation: [
    'open_thread',
    'open_view',
    'open_event',
    'open_area',
    'open_work',
    'discuss_area',
    'open_url',
  ],
} as const;

export type ImmediateBriefAction = (typeof BRIEF_ACTION_TIERS.immediate)[number];
export type ReviewBriefAction = (typeof BRIEF_ACTION_TIERS.review)[number];
export type NavigationBriefAction = (typeof BRIEF_ACTION_TIERS.navigation)[number];
export type KnownBriefAction = ImmediateBriefAction | ReviewBriefAction | NavigationBriefAction;
export type BriefActionTier = 'immediate' | 'review' | 'navigation' | 'unknown';

const immediate = new Set<string>(BRIEF_ACTION_TIERS.immediate);
const review = new Set<string>(BRIEF_ACTION_TIERS.review);
const navigation = new Set<string>(BRIEF_ACTION_TIERS.navigation);

export function briefActionTier(action: string): BriefActionTier {
  if (immediate.has(action)) return 'immediate';
  if (review.has(action)) return 'review';
  if (navigation.has(action)) return 'navigation';
  return 'unknown';
}

export function isKnownBriefAction(action: string): action is KnownBriefAction {
  return briefActionTier(action) !== 'unknown';
}

/** Steering actions sit in an item's overflow menu, not in its action row. */
export function isBriefSteeringAction(action: string): boolean {
  return action === 'steer_item';
}
