'use client';

import { useEffect, useMemo, useState } from 'react';
import type { NotificationItem } from '@/components/notifications/model';
import { useNotifications } from '@/components/notifications/useNotifications';
import { groupNeedsYou, type NeedsYouGroup, needsYouSummary } from '@/lib/obligations/groups';
import { useNeedsYouSnapshot } from './data';

/** The Albatross items that join the list: questions and approvals in Now, check-ins in Today. */
export function needsYouExtras(items: readonly NotificationItem[]): NotificationItem[] {
  return items.filter((item) => item.attention && item.kind !== 'update');
}

/** A clock that ticks every `intervalMs`, for "8 min" and "2 min ago". */
export function useNowMs(intervalMs = 30_000): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = globalThis.setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => globalThis.clearInterval(timer);
  }, [intervalMs]);
  return nowMs;
}

/**
 * The page, the bell, and the arrival toast read one shape: the snapshot, the
 * Albatross items, and the groups. `enabled` is false until the snapshot says
 * the user is in the flag.
 */
export function useNeedsYou() {
  const snapshot = useNeedsYouSnapshot();
  const notifications = useNotifications();
  const nowMs = useNowMs();
  const enabled = snapshot?.enabled === true;
  const extras = useMemo(
    () => needsYouExtras(notifications.projection.attention),
    [notifications.projection],
  );
  const groups: NeedsYouGroup<NotificationItem>[] = useMemo(
    () => (snapshot?.enabled ? groupNeedsYou(snapshot.items, extras, nowMs, snapshot.timezone) : []),
    [snapshot, extras, nowMs],
  );
  const summary = useMemo(() => needsYouSummary(groups), [groups]);
  return {
    snapshot,
    enabled,
    /** True while the snapshot or the Albatross items load. */
    isLoading: snapshot === undefined || notifications.isLoading,
    extras,
    groups,
    summary,
    nowMs,
    notifications,
  };
}
