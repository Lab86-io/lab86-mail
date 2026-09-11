'use client';

import { useConvexAuth, useQuery } from 'convex/react';
import { useEffect, useState } from 'react';
import type { DailyCheckinData } from '@/components/albatross/DailyCheckin';
import { api } from '@/convex/_generated/api';
import {
  type NotificationRow,
  type PendingApproval,
  type PendingQuestion,
  projectNotifications,
} from './model';

export interface CurrentMove {
  workId: string;
  workTitle: string;
  stepTitle: string;
  phase: 'active' | 'upcoming' | 'unscheduled';
}

/** Both the footer and page subscribe to these exact owners and bounds. */
export function useNotifications() {
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const center = useQuery(api.albatrossNotifications.liveCenter, isAuthenticated ? { limit: 100 } : 'skip') as
    | { notifications: NotificationRow[] }
    | undefined;
  const questions = useQuery(
    api.albatrossWorkV2.livePendingQuestions,
    isAuthenticated ? { limit: 100 } : 'skip',
  ) as PendingQuestion[] | undefined;
  const approvals = useQuery(api.albatrossWork.listApprovals, isAuthenticated ? { limit: 200 } : 'skip') as
    | PendingApproval[]
    | undefined;
  const checkin = useQuery(api.albatrossNotifications.currentCheckin, isAuthenticated ? {} : 'skip') as
    | (DailyCheckinData & { createdAt?: number })
    | null
    | undefined;
  const execution = useQuery(api.albatrossWorkV2.executionSnapshot, isAuthenticated ? { nowMs } : 'skip') as
    | { currentMove: CurrentMove | null }
    | undefined;
  useEffect(() => {
    if (!isAuthenticated) return;
    const timer = globalThis.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => globalThis.clearInterval(timer);
  }, [isAuthenticated]);
  const isLoading =
    authLoading ||
    (isAuthenticated && [center, questions, approvals, checkin].some((value) => value === undefined));
  return {
    isLoading,
    isAuthenticated,
    projection: projectNotifications({
      notifications: center?.notifications || [],
      questions: questions || [],
      approvals: approvals || [],
      checkin: checkin || null,
    }),
    currentMove: execution?.currentMove || null,
    checkin: checkin || null,
    recentLimitReached: (center?.notifications.length || 0) >= 100,
  };
}
