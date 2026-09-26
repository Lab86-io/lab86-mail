'use client';

import { useQuery } from '@tanstack/react-query';
import { callTool } from '@/lib/api-client';
import type { BriefSourceHealth, BriefSourceHealthSummary } from '@/lib/brief/source-health';
import { cn } from '@/lib/utils';

/* The source line under the masthead (FEATURES item 18). It names every
 * source behind the edition with its last sync, and it puts a source that
 * needs the user first, with the way to reconnect. A broken source must not
 * read as a quiet day. */

/** "just now", "4 min ago", "3 hours ago", "2 days ago". Exported for tests. */
export function syncedAgo(at: number | null, now = Date.now()): string {
  if (!at) return 'not synced yet';
  const diff = Math.max(0, now - at);
  if (diff < 60_000) return 'just now';
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

function sourceName(source: BriefSourceHealth) {
  return source.kind === 'calendar' ? `Calendar (${source.label})` : source.label;
}

export function BriefSourceLineView({
  health,
  now = Date.now(),
  className,
}: {
  health: BriefSourceHealthSummary;
  now?: number;
  className?: string;
}) {
  if (!health.sources.length) {
    return (
      <p data-brief-source-line className={cn('text-[12px] text-[var(--color-text-muted)]', className)}>
        {health.line}
      </p>
    );
  }
  const problems = health.sources.filter(
    (source) => source.status === 'reconnect' || source.status === 'error',
  );
  const others = health.sources.filter((source) => !problems.includes(source));
  return (
    <div data-brief-source-line className={cn('flex flex-col gap-1 text-[12px]', className)}>
      {problems.map((source) => (
        <p
          key={source.id}
          role="status"
          data-brief-source-problem={source.status}
          className="text-[var(--color-danger)]"
        >
          {source.detail}
          {source.reconnectPath ? (
            <>
              {' '}
              <a href={source.reconnectPath} className="font-medium underline underline-offset-2">
                Reconnect
              </a>
            </>
          ) : null}
        </p>
      ))}
      {others.length ? (
        <p className="text-[var(--color-text-muted)]">
          <span className="text-[var(--color-text-faint)]">Sources: </span>
          {others.map((source, index) => (
            <span key={source.id} data-brief-source={source.id} data-brief-source-status={source.status}>
              {index ? <span className="text-[var(--color-text-faint)]"> · </span> : null}
              <span className={source.inEdition ? 'text-[var(--color-text)]' : undefined}>
                {sourceName(source)}
              </span>{' '}
              <span
                className={
                  source.status === 'stale' || source.status === 'syncing'
                    ? 'text-[var(--color-warning)]'
                    : 'text-[var(--color-text-faint)]'
                }
              >
                {source.status === 'syncing' && !source.lastSyncedAt
                  ? 'still syncing'
                  : `synced ${syncedAgo(source.lastSyncedAt, now)}`}
              </span>
            </span>
          ))}
        </p>
      ) : null}
    </div>
  );
}

export function BriefSourceLine({ reportId, className }: { reportId?: string | null; className?: string }) {
  const health = useQuery({
    queryKey: ['brief-sources', reportId ?? 'none'],
    queryFn: async () =>
      (
        await callTool<{ health: BriefSourceHealthSummary }>(
          'get_brief_sources',
          reportId ? { reportId } : {},
        )
      ).health,
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
  if (!health.data) return null;
  return <BriefSourceLineView health={health.data} className={className} />;
}
