'use client';

import { type EvidenceLike, evidenceSourceLabel } from '@/lib/albatross/proof';
import { cn } from '@/lib/utils';

export interface LogArtifact {
  kind: string;
  id: string;
  title?: string;
  operationId?: string;
}

export interface ProjectLogRow {
  key: string;
  source: string;
  title: string;
  url: string | null;
  /** Null for a change with no time on it. */
  at: number | null;
  rejected: boolean;
}

const SOURCE_WORD: Record<string, string> = {
  github_commit: 'Commit',
  github_pull_request: 'Pull request',
  github_issue: 'Issue',
  github_project: 'Project',
  github_project_item: 'Project item',
  mail_thread: 'Mail',
  calendar_event: 'Calendar',
  task: 'Task',
  chat: 'Chat',
  question_answer: 'Answer',
  area_fact: 'Fact',
  mcp_item: 'Service',
  manual: 'You',
};

/** One word for where a log row came from. */
export function sourceWord(kind: string): string {
  const known = SOURCE_WORD[kind];
  if (known) return known;
  return evidenceSourceLabel(kind).replace(/^An? /, '');
}

/** "just now", "3h ago", "4d ago", then "Aug 12". */
export function agoLine(at: number, nowMs: number, locale = 'en-US'): string {
  const minutes = Math.floor(Math.max(0, nowMs - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(at).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

/**
 * The log rows in time order, newest first. Evidence carries a time. A
 * change Albatross made in an account has none, so those sit after.
 */
export function projectLogRows(evidence: EvidenceLike[], artifacts: LogArtifact[] = []): ProjectLogRow[] {
  const timed: ProjectLogRow[] = [...evidence]
    .sort((a, b) => b.occurredAt - a.occurredAt)
    .map((row, index) => ({
      key: `evidence:${row._id ?? index}`,
      source: sourceWord(row.sourceKind),
      title: row.title,
      url: row.url ?? null,
      at: row.occurredAt,
      rejected: row.trust === 'rejected',
    }));
  const changes: ProjectLogRow[] = artifacts.map((artifact) => ({
    key: `artifact:${artifact.kind}:${artifact.id}`,
    source: sourceWord(artifact.kind),
    title: artifact.title || artifact.id,
    url: null,
    at: null,
    rejected: false,
  }));
  return [...timed, ...changes];
}

/**
 * The project log: what happened, in time order, with "last touched" above.
 */
export function ProjectLog({
  evidence,
  artifacts = [],
  lastUserTouchAt,
  nowMs,
  className,
}: {
  evidence: EvidenceLike[];
  artifacts?: LogArtifact[];
  lastUserTouchAt?: number | null;
  nowMs: number;
  className?: string;
}) {
  const rows = projectLogRows(evidence, artifacts);
  return (
    <section aria-label="Log" data-project-log className={cn('mt-8', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-semibold">Log</h2>
        {typeof lastUserTouchAt === 'number' ? (
          <span data-last-touched className="text-[12px] text-[var(--color-accent-3)]">
            Last touched {agoLine(lastUserTouchAt, nowMs)}
          </span>
        ) : null}
      </div>
      {rows.length ? (
        <ul className="mt-2 divide-y divide-[var(--color-border)]/60">
          {rows.map((row) => (
            <li key={row.key} className={cn('flex items-baseline gap-3 py-2', row.rejected && 'opacity-55')}>
              <span className="w-24 shrink-0 text-[11.5px] text-[var(--color-text-faint)]">{row.source}</span>
              {row.url ? (
                <a
                  href={row.url}
                  target="_blank"
                  rel="noreferrer"
                  className={cn(
                    'min-w-0 flex-1 truncate text-[13px] underline-offset-2 hover:underline',
                    row.rejected && 'line-through',
                  )}
                >
                  {row.title}
                </a>
              ) : (
                <span className={cn('min-w-0 flex-1 truncate text-[13px]', row.rejected && 'line-through')}>
                  {row.title}
                </span>
              )}
              {row.at !== null ? (
                <span className="shrink-0 text-[11.5px] text-[var(--color-text-faint)]">
                  {agoLine(row.at, nowMs)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[12.5px] text-[var(--color-text-muted)]">Nothing in the log yet.</p>
      )}
    </section>
  );
}
