'use client';

// Projects lens over the task board: each project groups many bite-sized cards
// and shows the only number that matters — how much of it is done. Progress
// updates live through Convex reactivity; completing the last task plays one
// quiet, motion-based moment (no confetti, no icons).

import { useQuery as useHTTPQuery } from '@tanstack/react-query';
import { useConvexAuth, useMutation, useQuery } from 'convex/react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Checkbox } from '@/components/ui/checkbox';
import { api } from '@/convex/_generated/api';
import { callTool } from '@/lib/api-client';
import { cn } from '@/lib/utils';

// Cast like `boardsApi` in TasksSurface: the albatrossWork functions are being
// landed server-side; the UI builds against the frozen contract shapes below.
const workApi = (api as any).albatrossWork;
const boardsApi = (api as any).boards;

export type ProjectStatus = 'active' | 'paused' | 'done' | 'archived';

export interface ProjectSummary {
  _id: string;
  title: string;
  outcome?: string;
  status: ProjectStatus;
  areaId?: string;
  sourceIntentId?: string;
  createdAt: number;
  updatedAt: number;
  taskCount: number;
  completedTaskCount: number;
  intentCount: number;
  eventCount: number;
}

export interface ProjectTaskRow {
  cardId: string;
  boardId: string;
  title: string;
  completedAt?: number;
  dueAt?: number;
  updatedAt: number;
  columnName?: string;
}

export interface ProjectProgress {
  done: number;
  total: number;
  fraction: number;
  complete: boolean;
}

// Pure: clamp the counts into a progress snapshot. A project with no tasks is
// never "complete" — there is nothing to have finished.
export function projectProgress(project: { taskCount: number; completedTaskCount: number }): ProjectProgress {
  const total = Math.max(0, Math.floor(project.taskCount));
  const done = Math.min(Math.max(0, Math.floor(project.completedTaskCount)), total);
  return {
    done,
    total,
    fraction: total > 0 ? done / total : 0,
    complete: total > 0 && done >= total,
  };
}

// Pure: active work first, paused next, done collapsed at the bottom.
// Archived projects leave the lens entirely. Newest activity floats up.
export function projectGroups<T extends { status: ProjectStatus; updatedAt: number }>(
  projects: T[],
): { active: T[]; paused: T[]; done: T[] } {
  const byRecency = (a: T, b: T) => b.updatedAt - a.updatedAt;
  return {
    active: projects.filter((p) => p.status === 'active').sort(byRecency),
    paused: projects.filter((p) => p.status === 'paused').sort(byRecency),
    done: projects.filter((p) => p.status === 'done').sort(byRecency),
  };
}

// Pure: the celebration fires only when THIS session watched a project cross
// from incomplete to complete. No prior snapshot (first load) never fires.
export function celebrationTransition(
  prev: { done: number; total: number } | null | undefined,
  next: { done: number; total: number },
): boolean {
  if (!prev) return false;
  const before = projectProgress({ taskCount: prev.total, completedTaskCount: prev.done });
  const after = projectProgress({ taskCount: next.total, completedTaskCount: next.done });
  return !before.complete && after.complete;
}

// Pure: open tasks first (soonest due date, undated after, then recency);
// completed tasks sink to the bottom, most recently finished first.
export function orderProjectTasks<T extends { completedAt?: number; dueAt?: number; updatedAt: number }>(
  tasks: T[],
): T[] {
  const open = tasks.filter((t) => !t.completedAt);
  const done = tasks.filter((t) => Boolean(t.completedAt));
  open.sort((a, b) => {
    if (a.dueAt !== undefined && b.dueAt !== undefined && a.dueAt !== b.dueAt) return a.dueAt - b.dueAt;
    if (a.dueAt !== undefined && b.dueAt === undefined) return -1;
    if (a.dueAt === undefined && b.dueAt !== undefined) return 1;
    return b.updatedAt - a.updatedAt;
  });
  done.sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
  return [...open, ...done];
}

const CELEBRATION_MS = 4000;
const CELEBRATION_LINE = 'One less albatross.';

export function ProjectsLens({ onOpenTask }: { onOpenTask: (boardId: string, cardId: string) => void }) {
  const { isAuthenticated } = useConvexAuth();
  const reduced = useReducedMotion() ?? false;
  const liveProjects = useQuery(workApi.listProjectsWithProgress, isAuthenticated ? {} : 'skip') as
    | ProjectSummary[]
    | undefined;
  const fallbackProjects = useHTTPQuery({
    queryKey: ['projects', 'http-fallback'],
    queryFn: async () => {
      const result = await callTool<{ projects: Array<Partial<ProjectSummary> & { _id: string }> }>(
        'albatross_list_projects',
        { limit: 200 },
      );
      return result.projects.map(
        (project): ProjectSummary => ({
          _id: project._id,
          title: project.title || 'Untitled project',
          outcome: project.outcome,
          status: project.status || 'active',
          areaId: project.areaId,
          sourceIntentId: project.sourceIntentId,
          createdAt: project.createdAt || 0,
          updatedAt: project.updatedAt || project.createdAt || 0,
          taskCount: project.taskCount || 0,
          completedTaskCount: project.completedTaskCount || 0,
          intentCount: project.intentCount || 0,
          eventCount: project.eventCount || 0,
        }),
      );
    },
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const projects = liveProjects ?? fallbackProjects.data;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [doneOpen, setDoneOpen] = useState(false);
  const [loadTimedOut, setLoadTimedOut] = useState(false);

  useEffect(() => {
    if (projects) {
      setLoadTimedOut(false);
      return;
    }
    const timer = window.setTimeout(() => setLoadTimedOut(true), 12_000);
    return () => window.clearTimeout(timer);
  }, [projects]);

  // Session-scoped progress snapshots so completion is observed, not inferred
  // from the first payload. Keyed by project id.
  const prevProgress = useRef<Map<string, { done: number; total: number }>>(new Map());
  const [celebrating, setCelebrating] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!projects) return;
    const snapshots = prevProgress.current;
    const started: string[] = [];
    for (const project of projects) {
      const next = { done: project.completedTaskCount, total: project.taskCount };
      if (celebrationTransition(snapshots.get(project._id), next)) started.push(project._id);
      snapshots.set(project._id, next);
    }
    if (!started.length) return;
    setCelebrating((current) => {
      const merged = { ...current };
      for (const id of started) merged[id] = true;
      return merged;
    });
    const timer = setTimeout(() => {
      setCelebrating((current) => {
        const next = { ...current };
        for (const id of started) delete next[id];
        return next;
      });
    }, CELEBRATION_MS);
    return () => clearTimeout(timer);
  }, [projects]);

  const groups = useMemo(() => projectGroups(projects || []), [projects]);
  const visible = useMemo(() => [...groups.active, ...groups.paused, ...groups.done], [groups]);

  // Wide layout keeps a selection alive; explicit selection also drives the
  // narrow one-pane flow (list -> detail with a back link).
  const selected =
    (selectedId && visible.find((p) => p._id === selectedId)) || groups.active[0] || visible[0] || null;

  if (projects === undefined && loadTimedOut) {
    return (
      <div className="grid flex-1 place-items-center px-6 text-center">
        <div className="max-w-sm">
          <h2 className="text-[14px] font-semibold text-[var(--color-text)]">Tasks could not load</h2>
          <p className="mt-1 text-[12.5px] text-[var(--color-text-muted)]">
            The live task session did not authenticate and the provider-backed fallback returned no data.
          </p>
          <button
            type="button"
            onClick={() => {
              setLoadTimedOut(false);
              void fallbackProjects.refetch();
            }}
            className="mt-4 rounded-md border border-[var(--color-control-border)] bg-[var(--color-control)] px-3 py-2 text-[12px] font-medium"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  if (projects === undefined) {
    return (
      <div className="grid flex-1 place-items-center text-[13px] text-[var(--color-text-muted)]">
        Loading projects…
      </div>
    );
  }

  if (!visible.length) {
    return (
      <div className="grid flex-1 place-items-center px-6">
        <p className="max-w-sm text-center text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
          Projects are created when a plan is bigger than one task. Capture something ambitious.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div
        className={cn(
          'min-h-0 w-full flex-col overflow-y-auto border-[var(--color-border)] px-4 pb-4 pt-3 md:flex md:w-[320px] md:shrink-0 md:border-r',
          selectedId ? 'hidden md:flex' : 'flex',
        )}
      >
        <ProjectGroup
          projects={groups.active}
          selectedId={selected?._id || null}
          celebrating={celebrating}
          reduced={reduced}
          onSelect={setSelectedId}
        />
        {groups.paused.length ? (
          <>
            <GroupLabel>Paused</GroupLabel>
            <ProjectGroup
              projects={groups.paused}
              selectedId={selected?._id || null}
              celebrating={celebrating}
              reduced={reduced}
              onSelect={setSelectedId}
            />
          </>
        ) : null}
        {groups.done.length ? (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setDoneOpen((open) => !open)}
              aria-expanded={doneOpen}
              className="flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)]"
            >
              Done
              <span className="tabular-nums normal-case tracking-normal">{groups.done.length}</span>
              <span className="ml-auto normal-case tracking-normal font-normal">
                {doneOpen ? 'Hide' : 'Show'}
              </span>
            </button>
            {doneOpen ? (
              <ProjectGroup
                projects={groups.done}
                selectedId={selected?._id || null}
                celebrating={celebrating}
                reduced={reduced}
                onSelect={setSelectedId}
              />
            ) : null}
          </div>
        ) : null}
      </div>

      <div className={cn('min-h-0 min-w-0 flex-1 flex-col md:flex', selectedId ? 'flex' : 'hidden md:flex')}>
        {selected ? (
          <ProjectDetail
            key={selected._id}
            project={selected}
            celebrating={Boolean(celebrating[selected._id])}
            reduced={reduced}
            onBack={() => setSelectedId(null)}
            onOpenTask={onOpenTask}
          />
        ) : (
          <div className="grid flex-1 place-items-center text-[13px] text-[var(--color-text-muted)]">
            Select a project.
          </div>
        )}
      </div>
    </div>
  );
}

function GroupLabel({ children }: { children: string }) {
  return (
    <h2 className="mb-1 mt-3 px-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-faint)]">
      {children}
    </h2>
  );
}

function ProjectGroup({
  projects,
  selectedId,
  celebrating,
  reduced,
  onSelect,
}: {
  projects: ProjectSummary[];
  selectedId: string | null;
  celebrating: Record<string, boolean>;
  reduced: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <ul className="space-y-1.5">
      {projects.map((project) => (
        <ProjectRow
          key={project._id}
          project={project}
          selected={project._id === selectedId}
          celebrating={Boolean(celebrating[project._id])}
          reduced={reduced}
          onSelect={() => onSelect(project._id)}
        />
      ))}
    </ul>
  );
}

function ProjectRow({
  project,
  selected,
  celebrating,
  reduced,
  onSelect,
}: {
  project: ProjectSummary;
  selected: boolean;
  celebrating: boolean;
  reduced: boolean;
  onSelect: () => void;
}) {
  const progress = projectProgress(project);
  return (
    <motion.li
      // The one burst: a brief scale pulse when the last task lands.
      animate={celebrating && !reduced ? { scale: [1, 1.02, 1] } : { scale: 1 }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
    >
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          'block w-full rounded-xl border px-3 py-2.5 text-left transition-colors',
          selected
            ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
            : 'border-[var(--color-border)] bg-[var(--color-bg-elevated)] hover:border-[var(--color-border-strong)]',
        )}
      >
        <span
          className={cn(
            'block truncate text-[13.5px] font-semibold text-[var(--color-text)]',
            project.status === 'done' && 'text-[var(--color-text-muted)]',
          )}
        >
          {project.title}
        </span>
        {project.outcome ? (
          <span className="mt-0.5 block truncate text-[11.5px] text-[var(--color-text-muted)]">
            {project.outcome}
          </span>
        ) : null}
        <span className="mt-2 flex items-center gap-2">
          <ProgressBar fraction={progress.fraction} reduced={reduced} />
          <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-text-faint)]">
            {progress.done} of {progress.total}
          </span>
        </span>
        <AnimatePresence>
          {celebrating ? (
            <motion.span
              initial={reduced ? { opacity: 1 } : { opacity: 0, y: 2 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mt-1.5 block text-[11.5px] text-[var(--color-accent)]"
            >
              {CELEBRATION_LINE}
            </motion.span>
          ) : null}
        </AnimatePresence>
      </button>
    </motion.li>
  );
}

// Plain accent fill on a muted track — the house load-bar idiom, no gradients.
// The spring on width is also what makes live completion "tick up".
function ProgressBar({ fraction, reduced }: { fraction: number; reduced: boolean }) {
  return (
    <span className="block h-1.5 min-w-0 flex-1 overflow-hidden rounded-full border border-[var(--color-border)] bg-[var(--color-bg-muted)]">
      <motion.span
        className="block h-full rounded-full bg-[var(--color-accent)]"
        initial={false}
        animate={{ width: `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%` }}
        transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 170, damping: 26 }}
      />
    </span>
  );
}

function ProjectDetail({
  project,
  celebrating,
  reduced,
  onBack,
  onOpenTask,
}: {
  project: ProjectSummary;
  celebrating: boolean;
  reduced: boolean;
  onBack: () => void;
  onOpenTask: (boardId: string, cardId: string) => void;
}) {
  const tasks = useQuery(workApi.projectTasks, { projectId: project._id }) as ProjectTaskRow[] | undefined;
  const updateProject = useMutation(workApi.updateProject);
  const updateCard = useMutation(boardsApi.updateCard);
  const progress = projectProgress(project);
  const ordered = useMemo(() => orderProjectTasks(tasks || []), [tasks]);

  const setStatus = (status: ProjectStatus) => {
    void updateProject({ projectId: project._id, status }).catch((err: any) =>
      toast.error(err?.message || 'Could not update project'),
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pb-5 pt-3">
      <button
        type="button"
        onClick={onBack}
        className="mb-2 self-start text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] md:hidden"
      >
        Back to projects
      </button>
      <div className="mb-4">
        <div className="flex items-start justify-between gap-3">
          <h2 className="min-w-0 font-display text-[17px] font-semibold tracking-tight text-[var(--color-text)]">
            {project.title}
          </h2>
          <div className="flex shrink-0 items-center gap-1">
            {project.status !== 'done' ? (
              <QuietAction onClick={() => setStatus('done')}>Mark done</QuietAction>
            ) : null}
            {project.status === 'active' ? (
              <QuietAction onClick={() => setStatus('paused')}>Pause</QuietAction>
            ) : null}
            {project.status === 'paused' || project.status === 'done' ? (
              <QuietAction onClick={() => setStatus('active')}>Resume</QuietAction>
            ) : null}
            <QuietAction onClick={() => setStatus('archived')}>Archive</QuietAction>
          </div>
        </div>
        {project.outcome ? (
          <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
            {project.outcome}
          </p>
        ) : null}
        <div className="mt-3 flex items-center gap-2.5">
          <ProgressBar fraction={progress.fraction} reduced={reduced} />
          <span className="shrink-0 text-[12px] tabular-nums text-[var(--color-text-muted)]">
            {progress.done} of {progress.total} tasks
          </span>
        </div>
        <AnimatePresence>
          {celebrating ? (
            <motion.p
              initial={reduced ? { opacity: 1 } : { opacity: 0, y: 2 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mt-1.5 text-[12px] text-[var(--color-accent)]"
            >
              {CELEBRATION_LINE}
            </motion.p>
          ) : null}
        </AnimatePresence>
      </div>

      {tasks === undefined ? (
        <p className="text-[12.5px] text-[var(--color-text-muted)]">Loading tasks…</p>
      ) : ordered.length ? (
        <ul className="divide-y divide-[var(--color-border)] overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
          {ordered.map((task) => {
            const done = Boolean(task.completedAt);
            const overdue = task.dueAt && !done && task.dueAt < Date.now();
            return (
              <li key={task.cardId} className="flex items-center gap-2.5 px-3 py-2">
                <Checkbox
                  checked={done}
                  aria-label={done ? `Mark ${task.title} not done` : `Mark ${task.title} done`}
                  onCheckedChange={(checked) => {
                    void updateCard({
                      cardId: task.cardId,
                      completedAt: checked ? Date.now() : null,
                    }).catch((err: any) => toast.error(err?.message || 'Could not update task'));
                  }}
                />
                <button
                  type="button"
                  onClick={() => onOpenTask(task.boardId, task.cardId)}
                  title="Open on the board"
                  className="min-w-0 flex-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                >
                  <span
                    className={cn(
                      'block truncate text-[13.5px] text-[var(--color-text)]',
                      done && 'text-[var(--color-text-faint)] line-through',
                    )}
                  >
                    {task.title}
                  </span>
                </button>
                {task.dueAt ? (
                  <span
                    className={cn(
                      'shrink-0 text-[10.5px] tabular-nums',
                      overdue ? 'font-medium text-[var(--color-danger)]' : 'text-[var(--color-text-faint)]',
                    )}
                  >
                    {new Date(task.dueAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-[12.5px] text-[var(--color-text-muted)]">
          No tasks are linked to this project yet.
        </p>
      )}
    </div>
  );
}

function QuietAction({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-7 rounded-md px-2 text-[12px] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-text)]"
    >
      {children}
    </button>
  );
}
