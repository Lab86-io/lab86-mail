'use client';

// The area home page: everything one area of life currently touches — its
// mail, events, tasks, and verified context — sorted by the 30-minute
// classifier. Areas are becoming the primary sort of the app, so this surface
// reads like an operational inbox view, not a dashboard of cards.
//
// Research (Albatross contract - research before code):
// - Mobbin/Linear project overview (mobbin.com/screens/fed68772-ccc3-48be-8c28-3691a441728b):
//   one flat document with quiet properties and provenance in an activity rail —
//   density from typography, not boxes.
// - Mobbin/Notion teamspace home (mobbin.com/screens/f3758e63-6b03-49b8-82af-96bd6ee6edbf):
//   a space home is typed sections of dense rows over one scroll, each row a
//   real artifact.
// - Mobbin/Slack channel + canvas panel (mobbin.com/screens/fd0407b0-2598-4d7a-b155-616b385c2ccb):
//   the context pane rides beside the live stream; opening an item never
//   leaves the space.

import { useConvexAuth, useQuery_experimental as useConvexQuery, useMutation, useQuery } from 'convex/react';
import { useState } from 'react';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { areaHasNoLinks, areaHomeSections, formatEventTime, taskRowMeta } from '@/lib/albatross/area-home';
import { useClientStore } from '@/lib/client-state';
import { categoricalColor, formatDate, shortFrom } from '@/lib/shared/format';
import { cn } from '@/lib/utils';

interface AreaMailRow {
  providerThreadId: string;
  accountId: string;
  subject: string;
  fromAddress: string;
  lastDate: number;
  snippet: string;
  unread: boolean;
  linkStatus: string;
  confidence: number | null;
  reason: string | null;
}

interface AreaEventRow {
  providerEventId: string;
  accountId: string;
  title: string;
  startAt: number;
  endAt: number;
  allDay: boolean;
  location: string | null;
  linkStatus: string;
  reason: string | null;
}

interface AreaTaskRow {
  cardId: string;
  boardId: string;
  title: string;
  completedAt: number | null;
  dueAt: number | null;
  updatedAt: number;
  linkStatus: string;
  reason: string | null;
}

interface AreaFactRow {
  _id: string;
  kind: string;
  value: string;
  status: string;
}

interface AreaHomeData {
  area: { _id: string; name: string; kind: string; description?: string };
  facts: { verified: AreaFactRow[]; candidate: AreaFactRow[] };
  mail: AreaMailRow[];
  events: AreaEventRow[];
  tasks: AreaTaskRow[];
  counts: {
    facts: { verified: number; candidate: number };
    mail: number;
    events: number;
    tasks: number;
  };
}

export function AreaHome() {
  const selectedAreaId = useClientStore((s) => s.selectedAreaId);
  // Keyed remount per area: section scroll state and fact busy-state must not
  // leak between areas.
  return selectedAreaId ? <AreaHomeBody key={selectedAreaId} areaId={selectedAreaId} /> : <AreaChooser />;
}

// No area selected: the overview grid doubles as the chooser.
function AreaChooser() {
  const { isAuthenticated } = useConvexAuth();
  const setSelectedAreaId = useClientStore((s) => s.setSelectedAreaId);
  const areas = useQuery(api.albatross.listAreasOverview, isAuthenticated ? { status: 'active' } : 'skip') as
    | Array<{
        _id: string;
        name: string;
        kind: string;
        description?: string;
        factCounts: { verified: number; candidate: number };
      }>
    | undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-3">
        <h2 className="text-[15px] font-semibold tracking-tight">Areas</h2>
        {areas ? (
          <span className="text-[11.5px] text-[var(--color-text-faint)]">{areas.length} active</span>
        ) : null}
        <ManageLink className="ml-auto" />
      </header>
      {areas === undefined ? (
        <p className="px-4 py-6 text-[12.5px] text-[var(--color-text-muted)]">Loading areas…</p>
      ) : areas.length === 0 ? (
        <div className="px-4 py-8">
          <p className="max-w-md text-[13px] leading-relaxed text-[var(--color-text-muted)]">
            No areas yet. Set up the parts of your life you are responsible for and the classifier starts
            sorting mail, events, and tasks against them.
          </p>
          <Button asChild size="sm" className="mt-4">
            <a href="/settings?tab=areas">Set up areas</a>
          </Button>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-1 gap-3 overflow-y-auto p-4 sm:grid-cols-2 min-[1100px]:grid-cols-3">
          {areas.map((area) => (
            <button
              key={area._id}
              type="button"
              onClick={() => setSelectedAreaId(area._id)}
              className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-3 text-left transition-colors hover:bg-[var(--color-bg-muted)]"
            >
              <div className="flex items-center gap-2">
                <ToneDot id={area._id} />
                <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{area.name}</span>
                <Badge variant="outline" className="px-1.5 py-0 text-[10px] capitalize">
                  {area.kind}
                </Badge>
              </div>
              {area.description ? (
                <p className="mt-1 line-clamp-2 text-[12px] text-[var(--color-text-muted)]">
                  {area.description}
                </p>
              ) : null}
              <p className="mt-1.5 text-[11px] tabular-nums text-[var(--color-text-faint)]">
                {area.factCounts.verified} verified · {area.factCounts.candidate} suggested
              </p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AreaHomeBody({ areaId }: { areaId: string }) {
  const { isAuthenticated } = useConvexAuth();
  const setSelectedAreaId = useClientStore((s) => s.setSelectedAreaId);
  // Error-tolerant read: the persisted area id can outlive the area (deleted
  // in Settings) — that must degrade to the chooser, not a crashed surface.
  const result = useConvexQuery({
    query: (api as any).albatross.areaHome,
    args: isAuthenticated ? { areaId: areaId as Id<'areas'> } : 'skip',
  });

  if (result.status === 'error') {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-sm text-center">
          <p className="text-[13.5px] font-medium">This area is unavailable.</p>
          <p className="mt-1 text-[12.5px] text-[var(--color-text-muted)]">
            It may have been archived or removed in Settings.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-4"
            onClick={() => setSelectedAreaId(null)}
          >
            Show all areas
          </Button>
        </div>
      </div>
    );
  }
  if (result.status === 'pending') {
    return <p className="px-4 py-6 text-[12.5px] text-[var(--color-text-muted)]">Loading area…</p>;
  }

  const home = result.data as AreaHomeData;
  const sections = areaHomeSections(home.counts);
  const sectionCount = (id: string) => sections.find((section) => section.id === id)?.count ?? 0;
  const noLinks = areaHasNoLinks(home.counts);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2.5 border-b border-[var(--color-border)] px-4 py-3">
        <button
          type="button"
          onClick={() => setSelectedAreaId(null)}
          className="text-[12px] text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:underline"
        >
          Areas
        </button>
        <span className="text-[12px] text-[var(--color-text-faint)]">/</span>
        <ToneDot id={home.area._id} />
        <h2 className="min-w-0 truncate text-[15px] font-semibold tracking-tight">{home.area.name}</h2>
        <Badge variant="outline" className="px-1.5 py-0 text-[10px] capitalize">
          {home.area.kind}
        </Badge>
        <span className="hidden text-[11px] tabular-nums text-[var(--color-text-faint)] sm:inline">
          {home.counts.facts.verified} verified · {home.counts.facts.candidate} suggested
        </span>
        <ManageLink className="ml-auto" />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-10">
        {noLinks ? (
          <>
            <div className="mt-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-4">
              <p className="text-[13px] font-medium">Nothing linked here yet.</p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
                The classifier runs every 30 minutes and files this area&apos;s mail, events, and tasks as it
                learns your context. Add facts in Settings to sharpen it.
              </p>
            </div>
            <ContextSection home={home} count={sectionCount('context')} />
          </>
        ) : (
          <div className="grid gap-x-10 min-[1100px]:grid-cols-2">
            <div className="min-w-0">
              <MailSection mail={home.mail} count={sectionCount('mail')} />
            </div>
            <div className="min-w-0">
              <EventsSection events={home.events} count={sectionCount('events')} />
              <TasksSection tasks={home.tasks} count={sectionCount('tasks')} />
              <ContextSection home={home} count={sectionCount('context')} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MailSection({ mail, count }: { mail: AreaMailRow[]; count: number }) {
  const setSelectedThread = useClientStore((s) => s.setSelectedThread);
  const setThreadAccount = useClientStore((s) => s.setThreadAccount);

  return (
    <section>
      <SectionHeader label="Mail" count={count} />
      {mail.length === 0 ? (
        <SectionEmpty />
      ) : (
        mail.map((row) => {
          const sender = shortFrom(row.fromAddress) || row.fromAddress;
          return (
            <button
              key={`${row.accountId}:${row.providerThreadId}`}
              type="button"
              // Quiet provenance: the classifier's reason surfaces on hover only.
              title={row.reason ?? undefined}
              onClick={() => {
                // Same contract as the inbox: remember the owning mailbox so the
                // reader can load/reply; the reader pane slides in beside this
                // surface ('areas' is mail-ish in AppShell).
                setThreadAccount(row.accountId);
                setSelectedThread(row.providerThreadId);
              }}
              className="group grid w-full grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-[var(--color-border)]/45 px-3 py-2 text-left last:border-b-0 hover:bg-[var(--color-hover-soft)]"
            >
              <Avatar name={sender} size={28} />
              <div className={cn('flex min-w-0 flex-col gap-0.5', !row.unread && 'opacity-90')}>
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      'truncate font-display text-[13.5px]',
                      row.unread ? 'font-semibold text-[var(--color-text)]' : 'text-[var(--color-text)]/90',
                    )}
                  >
                    {sender}
                  </span>
                  {/* One indicator per row: an unverified classification outranks
                      the unread dot — trust before urgency. */}
                  {row.linkStatus === 'candidate' ? (
                    <SuggestedTag />
                  ) : row.unread ? (
                    <span className="size-1.5 shrink-0 rounded-full bg-[var(--color-accent)]" />
                  ) : null}
                </div>
                <span className="truncate text-[12.5px] leading-tight">
                  <span
                    className={
                      row.unread ? 'font-medium text-[var(--color-text)]' : 'text-[var(--color-text)]'
                    }
                  >
                    {row.subject || '(no subject)'}
                  </span>
                  {row.snippet ? (
                    <span className="text-[var(--color-text-muted)]"> — {row.snippet}</span>
                  ) : null}
                </span>
              </div>
              <span className="self-center text-[11px] font-medium tabular-nums text-[var(--color-text-muted)]">
                {formatDate(row.lastDate)}
              </span>
            </button>
          );
        })
      )}
    </section>
  );
}

function EventsSection({ events, count }: { events: AreaEventRow[]; count: number }) {
  const now = Date.now();
  return (
    <section>
      <SectionHeader label="Events" count={count} />
      {events.length === 0 ? (
        <SectionEmpty />
      ) : (
        events.map((event) => (
          <div
            key={`${event.accountId}:${event.providerEventId}`}
            title={event.reason ?? undefined}
            className={cn(
              'flex items-center gap-2.5 border-b border-[var(--color-border)]/45 px-3 py-2 last:border-b-0',
              event.endAt < now && 'opacity-70',
            )}
          >
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex items-center gap-1.5">
                <span className="truncate font-display text-[13px] font-medium">{event.title}</span>
                {event.linkStatus === 'candidate' ? <SuggestedTag /> : null}
              </div>
              <span className="truncate text-[11.5px] text-[var(--color-text-muted)]">
                {formatEventTime(event.startAt, event.endAt, event.allDay)}
                {event.location ? ` · ${event.location}` : ''}
              </span>
            </div>
          </div>
        ))
      )}
    </section>
  );
}

function TasksSection({ tasks, count }: { tasks: AreaTaskRow[]; count: number }) {
  return (
    <section>
      <SectionHeader label="Tasks" count={count} />
      {tasks.length === 0 ? (
        <SectionEmpty />
      ) : (
        tasks.map((task) => {
          const meta = taskRowMeta(task);
          const done = meta.state === 'done';
          return (
            <div
              key={task.cardId}
              title={task.reason ?? undefined}
              className="flex items-center gap-2.5 border-b border-[var(--color-border)]/45 px-3 py-2 last:border-b-0"
            >
              <span
                className={cn(
                  'size-3.5 shrink-0 rounded-full border',
                  done
                    ? 'border-[var(--color-transparent)] bg-emerald-500/85'
                    : 'border-[var(--color-border)]',
                )}
                aria-hidden
              />
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-[13px]',
                  done && 'text-[var(--color-text-muted)] line-through',
                )}
              >
                {task.title}
              </span>
              {task.linkStatus === 'candidate' ? <SuggestedTag /> : null}
              <span
                className={cn(
                  'shrink-0 text-[11px] tabular-nums',
                  meta.state === 'overdue' ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]',
                )}
              >
                {meta.label}
              </span>
            </div>
          );
        })
      )}
    </section>
  );
}

function ContextSection({ home, count }: { home: AreaHomeData; count: number }) {
  const verifyFact = useMutation(api.albatross.verifyAreaFact);
  const rejectFact = useMutation(api.albatross.rejectAreaFact);
  const [busyFactId, setBusyFactId] = useState<string | null>(null);

  const verify = async (fact: AreaFactRow) => {
    setBusyFactId(fact._id);
    try {
      // The click is the explicit user confirmation the trust model requires.
      await verifyFact({
        factId: fact._id as Id<'areaFacts'>,
        confirmationRefs: [
          { kind: 'user_confirmation', id: `area-home:${fact._id}:${Date.now()}`, confirmedAt: Date.now() },
        ],
      });
    } finally {
      setBusyFactId(null);
    }
  };

  const reject = async (fact: AreaFactRow) => {
    setBusyFactId(fact._id);
    try {
      await rejectFact({ factId: fact._id as Id<'areaFacts'>, reason: 'Rejected from area home' });
    } finally {
      setBusyFactId(null);
    }
  };

  return (
    <section>
      <SectionHeader label="Context" count={count} />
      {home.facts.candidate.map((fact) => (
        <div
          key={fact._id}
          className={cn(
            'flex items-center gap-2 border-b border-[var(--color-border)]/45 px-3 py-2 last:border-b-0',
            busyFactId === fact._id && 'opacity-60',
          )}
        >
          <span className="w-16 shrink-0 truncate text-[10.5px] capitalize text-[var(--color-text-faint)]">
            {fact.kind}
          </span>
          <span className="min-w-0 flex-1 truncate text-[12.5px]">{fact.value}</span>
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={busyFactId === fact._id}
            onClick={() => verify(fact)}
          >
            Verify
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={busyFactId === fact._id}
            onClick={() => reject(fact)}
          >
            Reject
          </Button>
        </div>
      ))}
      {home.facts.verified.map((fact) => (
        <div
          key={fact._id}
          className="flex items-baseline gap-2 border-b border-[var(--color-border)]/45 px-3 py-2 last:border-b-0"
        >
          <span className="w-16 shrink-0 truncate text-[10.5px] capitalize text-[var(--color-text-faint)]">
            {fact.kind}
          </span>
          <span className="min-w-0 flex-1 truncate text-[12.5px]">{fact.value}</span>
        </div>
      ))}
      {count === 0 ? (
        <p className="px-3 py-3 text-[12px] text-[var(--color-text-muted)]">
          No facts yet —{' '}
          <a href="/settings?tab=areas" className="underline-offset-2 hover:underline">
            teach this area in Settings
          </a>
          .
        </p>
      ) : null}
    </section>
  );
}

// Editorial section rule matching the inbox's date group headers, so the area
// home reads as the same publication as the rest of the app.
function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-baseline gap-2.5 px-3 pb-1 pt-5">
      <span className="font-display text-[12.5px] italic leading-none text-[var(--color-text-muted)]">
        {label}
      </span>
      {count > 0 ? (
        <span className="text-[11px] tabular-nums leading-none text-[var(--color-text-faint)]">{count}</span>
      ) : null}
      <span className="h-px flex-1 self-center bg-[var(--color-border)]/70" />
    </div>
  );
}

function SectionEmpty() {
  return (
    <p className="px-3 py-3 text-[12px] text-[var(--color-text-muted)]">
      Nothing classified here yet — the classifier runs every 30 minutes.
    </p>
  );
}

// The quiet per-row provenance tag for AI-suggested (unverified) links.
function SuggestedTag() {
  return (
    <span className="shrink-0 rounded border border-[var(--color-border)] px-1 text-[10px] leading-[1.5] text-[var(--color-text-faint)]">
      Suggested
    </span>
  );
}

function ToneDot({ id }: { id: string }) {
  return (
    <span className="grid size-4 shrink-0 place-items-center" aria-hidden>
      <span className="size-2 rounded-full" style={{ backgroundColor: categoricalColor(id) }} />
    </span>
  );
}

function ManageLink({ className }: { className?: string }) {
  return (
    <a
      href="/settings?tab=areas"
      className={cn(
        'text-[12px] text-[var(--color-text-muted)] underline-offset-2 hover:text-[var(--color-text)] hover:underline',
        className,
      )}
    >
      Manage
    </a>
  );
}
