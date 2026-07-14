// Pure load-scheduling policy for the infinite inbox list.
//
// The list should never make a fast scroller wait at the wall: the next page
// is requested while the sentinel is still well below the viewport, and when
// a page lands with the sentinel still inside that window the following page
// is requested immediately (pipelined) instead of waiting for another scroll
// event. This helper is the single yes/no gate both triggers share, so the
// duplicate-request and error rules live in one testable place.

/**
 * How far below the viewport (in px) the end-of-list sentinel may be while we
 * still prefetch the next page. Roughly two viewports of 57px rows.
 */
export const LIST_PREFETCH_MARGIN_PX = 1800;

export interface NextPageDecision {
  /** A next-page request is already running — never double-fetch a cursor. */
  inFlight: boolean;
  /** The paginator still has a cursor to continue from. */
  hasMore: boolean;
  /**
   * Pixels from the bottom of the scroll viewport to the sentinel.
   * Zero/negative means visible; Infinity means unknown or far away.
   */
  distanceToEnd: number;
  /** The last fetch errored — stop auto-chaining and let the user retry. */
  lastError?: boolean;
  /** Override the prefetch window (defaults to LIST_PREFETCH_MARGIN_PX). */
  prefetchDistance?: number;
}

export function shouldRequestNextPage({
  inFlight,
  hasMore,
  distanceToEnd,
  lastError = false,
  prefetchDistance = LIST_PREFETCH_MARGIN_PX,
}: NextPageDecision): boolean {
  if (!hasMore || inFlight || lastError) return false;
  if (!Number.isFinite(distanceToEnd)) return false;
  return distanceToEnd <= prefetchDistance;
}
