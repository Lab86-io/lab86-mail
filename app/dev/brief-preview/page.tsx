'use client';

import { notFound, useSearchParams } from 'next/navigation';
import { TodayNeedsYou } from '@/components/needs-you/TodayNeedsYou';
import type { NotificationItem } from '@/components/notifications/model';
import { BriefCanvas } from '@/components/report/brief-canvas/BriefCanvas';
import { BriefLiveLayer } from '@/components/report/live-layer';
import { QueryProvider } from '@/components/shell/QueryProvider';
import { useApplyThemeExtras } from '@/components/shell/ThemePanel';
import {
  NEEDS_YOU_FIXTURE_NOW,
  needsYouEditorialFixture,
  needsYouFixture,
  needsYouLetterFixture,
} from '@/lib/obligations/fixtures';
import {
  areaPulseDocumentFixture,
  letterBriefDocumentFixture,
  richBriefDocumentFixture,
} from '@/lib/shared/brief-document-fixtures';

/* Dev-only harness: a fixture through the real BriefCanvas, full viewport, so
 * layout, theming, and depth can be verified deterministically without a
 * signed-in account that owns a brief. Query switches:
 *   ?layout=letter (default)  the budget letter: lede, lanes, week ahead, areas
 *   ?layout=area              the area pulse letter
 *   ?layout=needs-you         the daily letter of a Needs you user: the Needs you lane in the place of Answer
 *   ?layout=needs-you-editorial  the same day as an editorial edition, the form real daily editions take
 *   ?layout=grid              the older editorial grid, for old editions
 *   ?embedded=1               the shape Today renders: no masthead, parent scroll
 *   ?noise=42                 the footer count of the letter
 *   ?frame=robert-gilt        pins one picture frame on the masthead
 *   ?live=1                   the live Needs you list of Today under the masthead; the stored lane hides
 * Not linked from anywhere; 404s outside development. */
export default function BriefPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <BriefPreviewInner />;
}

function BriefPreviewInner() {
  useApplyThemeExtras();
  const params = useSearchParams();
  const embedded = params.get('embedded') === '1';
  const layout = params.get('layout') ?? 'letter';
  const noiseParam = Number(params.get('noise') ?? '42');
  const noiseCount = Number.isFinite(noiseParam) ? noiseParam : null;
  const frame = params.get('frame');
  const live = params.get('live') === '1';
  const value =
    layout === 'grid'
      ? richBriefDocumentFixture
      : layout === 'area'
        ? areaPulseDocumentFixture
        : layout === 'needs-you'
          ? needsYouLetterFixture()
          : layout === 'needs-you-editorial'
            ? needsYouEditorialFixture()
            : letterBriefDocumentFixture;
  const layer = live ? { node: <LiveListStandIn />, hideNeedsYou: true } : null;
  return (
    <QueryProvider clerkEnabled={false}>
      <BriefLiveLayer.Provider value={layer}>
        {embedded ? (
          <div className="mx-auto max-w-5xl px-5 py-10">
            <p className="mb-8 text-[13px] text-[var(--color-text-muted)]">
              Stand-in for the live layer of Today. The brief follows in the same scroll.
            </p>
            <div className="mb-3 flex flex-wrap items-baseline gap-x-3">
              <span aria-hidden className="h-px w-5 shrink-0 bg-[var(--color-border-strong)]" />
              <h2 className="font-serif text-[15px] font-semibold">The brief</h2>
              <p className="text-[12px] text-[var(--color-text-faint)]">
                Written just now, from your mail and calendar.
              </p>
              <span aria-hidden className="h-px flex-1 bg-[var(--color-border)]" />
            </div>
            <BriefCanvas value={value} embedded noiseCount={noiseCount} liveSections={live} />
          </div>
        ) : (
          <div className="h-dvh">
            <BriefCanvas
              value={value}
              masthead={layout !== 'area'}
              mastheadFrame={frame}
              noiseCount={noiseCount}
              liveSections={live}
            />
          </div>
        )}
      </BriefLiveLayer.Provider>
    </QueryProvider>
  );
}

/** The live list from the fixtures, as Today shows it. Actions answer in place and change nothing else. */
function LiveListStandIn() {
  const fixture = needsYouFixture();
  return (
    <TodayNeedsYou
      items={fixture.items}
      extras={fixture.extras as unknown as NotificationItem[]}
      timezone={fixture.timezone}
      now={NEEDS_YOU_FIXTURE_NOW}
      post={async (obligation, action) => ({
        obligation: {
          ...obligation,
          state: action.action === 'later' ? 'snoozed' : action.action === 'undo' ? 'open' : 'done',
          updatedAt: Date.now(),
        },
        undoUntil: Date.now() + 10_000,
      })}
      loadDraft={async () => ({
        draft: { to: [], cc: [], subject: '', body: 'Hi Dana, November 16 works.' },
      })}
      sendReply={async (obligation) => ({
        obligation: { ...obligation, state: 'done', closeReason: 'sent_reply', updatedAt: Date.now() },
      })}
      startAlbatross={async (obligation) => ({ workId: 'work_new', created: true, obligation })}
      onOpenItem={() => undefined}
      onOpenPage={() => undefined}
      onOpenWork={() => undefined}
      onAlbatrossAction={() => undefined}
    />
  );
}
