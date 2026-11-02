'use client';

import type { PrimaryView } from '@/lib/shared/types';
import { createSurfacePreloader, nextSurfaces, whenBrowserIdle } from '@/lib/shell/surface-preload';

// One chunk per surface. The shell's dynamic() calls and the preloader share
// these functions, so a preload makes the later render instant.
export const loadActivitySurface = () => import('@/components/albatross/ActivitySurface');
export const loadAlbatrossesSurface = () => import('@/components/albatross/AlbatrossesSurface');
export const loadAreaHome = () => import('@/components/albatross/AreaHome');
export const loadWorkThread = () => import('@/components/albatross/WorkThread');
export const loadCalendarSurface = () => import('@/components/calendar/CalendarSurface');
export const loadFilesSurface = () => import('@/components/files/FilesSurface');
export const loadInbox = () => import('@/components/inbox/Inbox');
export const loadNeedsYouSurface = () => import('@/components/needs-you/NeedsYouSurface');
export const loadToday = () => import('@/components/report/Today');
export const loadTasksSurface = () => import('@/components/tasks/TasksSurface');
export const loadThreadView = () => import('@/components/thread/ThreadView');

/** Starts the load of a surface. The rail calls it on hover and on keyboard focus. */
export const preloadSurface = createSurfacePreloader({
  activity: loadActivitySurface,
  albatrosses: loadAlbatrossesSurface,
  areas: loadAreaHome,
  calendar: loadCalendarSurface,
  files: loadFilesSurface,
  mail: () => Promise.all([loadInbox(), loadThreadView()]),
  notifications: loadNeedsYouSurface,
  tasks: loadTasksSurface,
  today: loadToday,
});

/** After the current surface paints, loads the surfaces that come next most often. */
export function preloadNextSurfacesWhenIdle(view: PrimaryView) {
  return whenBrowserIdle(() => {
    for (const next of nextSurfaces(view)) preloadSurface(next);
  });
}
