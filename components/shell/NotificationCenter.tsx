'use client';

import { useConvexAuth, useMutation, useQuery } from 'convex/react';
import { Bell, Check, X } from 'lucide-react';
import { useState } from 'react';
import { DailyCheckin, type DailyCheckinData } from '@/components/albatross/DailyCheckin';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { useClientStore } from '@/lib/client-state';
import { cn } from '@/lib/utils';
import { SuggestionsTray } from './SuggestionsTray';

interface NotificationRow {
  _id: string;
  type: string;
  title: string;
  body: string;
  status: string;
  entityKind?: string;
  entityId?: string;
  deepLink: string;
  createdAt: number;
}

interface CenterData {
  unread: number;
  notifications: NotificationRow[];
}

export function NotificationCenter({ className }: { className?: string } = {}) {
  const { isAuthenticated } = useConvexAuth();
  const center = useQuery(api.albatrossNotifications.liveCenter, isAuthenticated ? { limit: 50 } : 'skip') as
    | CenterData
    | undefined;
  const checkin = useQuery(api.albatrossNotifications.currentCheckin, isAuthenticated ? {} : 'skip') as
    | DailyCheckinData
    | null
    | undefined;
  const questions = useQuery(
    api.albatrossWorkV2.livePendingQuestions,
    isAuthenticated ? { limit: 20 } : 'skip',
  ) as
    | Array<{
        question: { _id: string; prompt: string; reason?: string };
        work: null | { _id: string; title?: string; rawText: string };
        project: null | { _id: string; title: string; areaId?: string };
        routine: null | { _id: string; title: string; areaId?: string };
      }>
    | undefined;
  const approvals = useQuery(api.albatrossWork.listApprovals, isAuthenticated ? { limit: 20 } : 'skip') as
    | Array<{ _id: string; title: string; detail?: string; intentId?: string; status: string }>
    | undefined;
  const mark = useMutation(api.albatrossNotifications.markNotification);
  const openCheckin = useMutation(api.albatrossNotifications.openCheckin);
  const setPrimaryView = useClientStore((state) => state.setPrimaryView);
  const setSelectedWorkId = useClientStore((state) => state.setSelectedWorkId);
  const setSelectedAreaId = useClientStore((state) => state.setSelectedAreaId);
  const [open, setOpen] = useState(false);
  const [checkinOpen, setCheckinOpen] = useState(false);

  const act = async (row: NotificationRow) => {
    await mark({ notificationId: row._id as Id<'albatrossNotifications'>, status: 'acted' });
    if (row.entityKind === 'work' && row.entityId) {
      setSelectedWorkId(row.entityId);
      setPrimaryView('areas');
      setOpen(false);
      return;
    }
    if (row.entityKind === 'checkin' || row.type === 'daily_checkin') {
      if (checkin) {
        await openCheckin({ checkinId: checkin._id as Id<'albatrossDailyCheckins'> }).catch(() => undefined);
      }
      setCheckinOpen(true);
      setOpen(false);
      return;
    }
    if (row.deepLink?.includes('daily')) setPrimaryView('daily_report');
    setOpen(false);
  };

  const rows = center?.notifications || [];
  const attentionCount = (center?.unread || 0) + (questions?.length || 0) + (approvals?.length || 0);
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={attentionCount ? `${attentionCount} items need attention` : 'Notifications'}
            className={cn(
              'relative grid size-7 shrink-0 place-items-center rounded-md border border-[var(--color-control-border)] bg-[var(--color-control)] text-[var(--color-text-muted)] shadow-[var(--shadow-control)] transition-colors hover:border-[var(--color-border-strong)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-text)] group-data-[collapsible=icon]:size-8',
              className,
            )}
          >
            <Bell className="size-4" />
            {attentionCount ? (
              <span className="absolute -right-1 -top-1 min-w-4 rounded-full border-2 border-[var(--color-bg-elevated)] bg-[var(--color-danger)] px-1 text-center text-[9px] font-semibold leading-3 text-white">
                {Math.min(attentionCount, 99)}
              </span>
            ) : null}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" sideOffset={8} className="w-[min(390px,calc(100vw-2rem))] p-0">
          <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3.5 py-3">
            <div>
              <h2 className="text-[13px] font-semibold">Notifications</h2>
              <p className="text-[10.5px] text-[var(--color-text-faint)]">
                Questions, check-ins, approvals, and updates
              </p>
            </div>
            {checkin ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  setCheckinOpen(true);
                  setOpen(false);
                }}
              >
                Check in
              </Button>
            ) : null}
          </div>
          <div className="max-h-[55vh] overflow-y-auto">
            {questions?.map((row) => (
              <button
                key={row.question._id}
                type="button"
                onClick={() => {
                  setSelectedWorkId(row.work ? String(row.work._id) : null);
                  const areaId = row.routine?.areaId || row.project?.areaId;
                  setSelectedAreaId(areaId ? String(areaId) : null);
                  setPrimaryView('areas');
                  setOpen(false);
                }}
                className="flex w-full gap-2 border-b border-[var(--color-border)]/60 bg-[var(--color-warning-soft)]/45 px-3.5 py-3 text-left hover:bg-[var(--color-warning-soft)]"
              >
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-[var(--color-warning)]" />
                <span>
                  <span className="block text-[12.5px] font-medium">{row.question.prompt}</span>
                  <span className="mt-0.5 block text-[11.5px] text-[var(--color-text-muted)]">
                    {row.work?.title ||
                      row.work?.rawText ||
                      row.project?.title ||
                      row.routine?.title ||
                      'Albatross needs an answer'}
                  </span>
                </span>
              </button>
            ))}
            {approvals?.map((approval) => (
              <button
                key={approval._id}
                type="button"
                onClick={() => {
                  if (approval.intentId) {
                    setSelectedWorkId(approval.intentId);
                    setPrimaryView('areas');
                  }
                  setOpen(false);
                }}
                className="flex w-full gap-2 border-b border-[var(--color-border)]/60 px-3.5 py-3 text-left hover:bg-[var(--color-hover-soft)]"
              >
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-[var(--color-danger)]" />
                <span>
                  <span className="block text-[12.5px] font-medium">Approval · {approval.title}</span>
                  {approval.detail ? (
                    <span className="mt-0.5 block text-[11.5px] text-[var(--color-text-muted)]">
                      {approval.detail}
                    </span>
                  ) : null}
                </span>
              </button>
            ))}
            {rows.length ? (
              rows.map((row) => {
                const unread = row.status === 'queued' || row.status === 'delivered';
                return (
                  <div
                    key={row._id}
                    className={cn(
                      'group border-b border-[var(--color-border)]/60 px-3.5 py-3',
                      unread && 'bg-[var(--color-accent-soft)]/35',
                    )}
                  >
                    <button type="button" onClick={() => void act(row)} className="w-full text-left">
                      <div className="flex items-start gap-2">
                        <span
                          className={cn(
                            'mt-1.5 size-1.5 shrink-0 rounded-full',
                            unread ? 'bg-[var(--color-accent)]' : 'bg-transparent',
                          )}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[12.5px] font-medium">{row.title}</span>
                          <span className="mt-0.5 block text-[11.5px] leading-snug text-[var(--color-text-muted)]">
                            {row.body}
                          </span>
                        </span>
                      </div>
                    </button>
                    <div className="mt-1.5 flex justify-end gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                      {unread ? (
                        <button
                          type="button"
                          aria-label="Mark read"
                          onClick={() =>
                            void mark({
                              notificationId: row._id as Id<'albatrossNotifications'>,
                              status: 'read',
                            })
                          }
                          className="rounded p-1 text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
                        >
                          <Check className="size-3" />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        aria-label="Dismiss"
                        onClick={() =>
                          void mark({
                            notificationId: row._id as Id<'albatrossNotifications'>,
                            status: 'dismissed',
                          })
                        }
                        className="rounded p-1 text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
                      >
                        <X className="size-3" />
                      </button>
                    </div>
                  </div>
                );
              })
            ) : !questions?.length && !approvals?.length ? (
              <p className="px-4 py-8 text-center text-[12px] text-[var(--color-text-muted)]">
                Nothing needs your attention.
              </p>
            ) : null}
          </div>
          <div className="border-t border-[var(--color-border)] p-2">
            <SuggestionsTray />
          </div>
        </PopoverContent>
      </Popover>
      <DailyCheckin checkin={checkin || null} open={checkinOpen} onOpenChange={setCheckinOpen} />
    </>
  );
}
