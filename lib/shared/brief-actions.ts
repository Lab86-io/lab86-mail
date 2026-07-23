export const BRIEF_ACTION_TIERS = {
  immediate: ['toggle_task', 'dismiss_task', 'resolve_thread', 'dismiss_thread', 'archive_thread'],
  review: ['rsvp_event', 'create_task', 'create_event', 'draft_reply', 'capture_intent', 'answer_question'],
  navigation: ['open_thread', 'open_view', 'open_event', 'open_area', 'open_work', 'discuss_area'],
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

export function isImmediateBriefAction(action: string): action is ImmediateBriefAction {
  return immediate.has(action);
}

export function isReviewBriefAction(action: string): action is ReviewBriefAction {
  return review.has(action);
}
