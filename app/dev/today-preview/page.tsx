'use client';

import { notFound, useSearchParams } from 'next/navigation';
import { useMemo } from 'react';
import { TodayLive } from '@/components/needs-you/TodayNeedsYou';
import { WorthKnowing } from '@/components/needs-you/WorthKnowing';
import type { NotificationItem } from '@/components/notifications/model';
import { BriefCanvas } from '@/components/report/brief-canvas/BriefCanvas';
import { BriefLiveLayer } from '@/components/report/live-layer';
import { QueryProvider } from '@/components/shell/QueryProvider';
import { useApplyThemeExtras } from '@/components/shell/ThemePanel';
import { NEEDS_YOU_FIXTURE_NOW, NEEDS_YOU_FIXTURE_TIMEZONE } from '@/lib/obligations/fixtures';
import {
  TODAY_PREVIEW_EVENTS,
  TODAY_PREVIEW_ITEMS,
  TODAY_PREVIEW_WORTH,
} from '@/lib/obligations/today-fixtures';
import { letterBriefDocumentFixture } from '@/lib/shared/brief-document-fixtures';

/* Dev-only harness: the live Today page over invented data, through the real
 * components. Query switches:
 *   ?at=16        the hour of the clock (the default is 11:05 AM)
 *   ?state=clear  nothing needs the user
 *   ?state=quiet  an empty calendar
 * Not linked from anywhere; 404s outside development. */
export default function TodayPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <QueryProvider clerkEnabled={false}>
      <Inner />
    </QueryProvider>
  );
}

function Inner() {
  useApplyThemeExtras();
  const params = useSearchParams();
  const hour = Number(params.get('at'));
  const state = params.get('state');
  const now =
    Number.isFinite(hour) && hour > 0
      ? NEEDS_YOU_FIXTURE_NOW + (hour - 11) * 3_600_000
      : NEEDS_YOU_FIXTURE_NOW;
  const items = state === 'clear' ? [] : TODAY_PREVIEW_ITEMS;
  const events = state === 'quiet' ? [] : TODAY_PREVIEW_EVENTS;
  const live = useMemo(
    () => ({
      hideNeedsYou: true,
      replacesDocument: true,
      node: (
        <TodayLive
          items={items}
          extras={[] as NotificationItem[]}
          timezone={NEEDS_YOU_FIXTURE_TIMEZONE}
          now={now}
          events={events}
          post={async () => {
            throw new Error('The preview does not save.');
          }}
          onOpenCalendar={() => undefined}
          loadDraft={async () => {
            throw new Error('The preview has no drafts.');
          }}
          sendReply={async () => {
            throw new Error('The preview does not send.');
          }}
          startAlbatross={async () => {
            throw new Error('The preview does not start work.');
          }}
          onOpenItem={() => undefined}
          onOpenPage={() => undefined}
          onOpenWork={() => undefined}
          onAlbatrossAction={() => undefined}
        />
      ),
    }),
    [items, events, now],
  );
  return (
    <div className="h-screen bg-[var(--color-content)]">
      <BriefLiveLayer.Provider value={live}>
        <BriefCanvas
          value={{ ...letterBriefDocumentFixture, generatedAt: now, timezone: NEEDS_YOU_FIXTURE_TIMEZONE }}
          liveSections
          masthead
          footer={
            <div className="daily-brief-layout mt-2">
              <WorthKnowing items={TODAY_PREVIEW_WORTH} />
            </div>
          }
        />
      </BriefLiveLayer.Provider>
    </div>
  );
}
