'use client';

import type { ReactNode } from 'react';
import { type EvidenceLike, evidenceSourceLabel, latestProof, proofSummary } from '@/lib/albatross/proof';
import {
  needsYou,
  WORK_STATE_LABEL,
  type WorkStateInput,
  type WorkStateKey,
  workStateKey,
} from '@/lib/albatross/work-state';
import { cn } from '@/lib/utils';

/**
 * State reads by shape and weight, not by colour. Needs-you is raised, waiting
 * is dashed, finished recedes. Red belongs to errors only.
 */
export function StateChip({ state, className }: { state: WorkStateKey; className?: string }) {
  return (
    <span
      data-state={state}
      className={cn(
        'shrink-0 rounded-full px-2 py-0.5 text-[11px] leading-none',
        state === 'needs_you'
          ? 'bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)] shadow-[var(--shadow-soft)]'
          : state === 'waiting' || state === 'unresolved'
            ? 'border border-dashed border-[var(--color-border-strong)] text-[var(--color-text-muted)]'
            : state === 'done' || state === 'archived'
              ? 'text-[var(--color-text-faint)]'
              : 'border border-[var(--color-border)] text-[var(--color-text-muted)]',
        className,
      )}
    >
      {WORK_STATE_LABEL[state]}
    </span>
  );
}

/**
 * The one sentence that says what happens next. Never a count, never a score.
 */
export function nextMoveLine(work: WorkStateInput & { openQuestions?: number }): string {
  const open = work.openQuestions ?? 0;
  if (open === 1) return 'One question waiting for you';
  if (open > 1) return `${open} questions waiting for you`;
  if (work.agentState === 'error' || work.planError) return 'Something went wrong — take a look';
  if (work.agentState === 'researching') return 'Albatross is looking into it';
  if (work.agentState === 'applying') return 'Albatross is making the changes';
  if (work.workState === 'waiting' || work.workState === 'blocked') return 'Waiting on somebody else';
  if (work.workState === 'paused') return 'Paused by you';
  if (work.workState === 'archived') return 'You put this down';
  if (work.workState === 'done') return 'Finished';
  return 'Albatross is carrying this';
}

export function NextMove({ work, className }: { work: WorkStateInput; className?: string }) {
  return (
    <span className={cn('text-[12px] text-[var(--color-text-muted)]', className)}>{nextMoveLine(work)}</span>
  );
}

/**
 * The three facts that describe an Albatross completely: what done looks like,
 * what happens next, and whether anything has proved it. One line, always the
 * same three, so the model is legible from any Albatross at a glance.
 */
export function OutcomeHeader({
  outcome,
  summary,
  work,
  evidence,
  state,
  actions,
}: {
  outcome: string;
  summary?: string | null;
  work: WorkStateInput;
  evidence: EvidenceLike[];
  state: WorkStateKey;
  actions?: ReactNode;
}) {
  return (
    <header className="border-b border-[var(--color-border)] pb-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 max-w-2xl">
          <p className="text-[11.5px] text-[var(--color-text-faint)]">Outcome</p>
          <h1 className="mt-2 font-serif text-[clamp(25px,4vw,38px)] font-semibold leading-[1.08] tracking-tight">
            {outcome}
          </h1>
          {summary ? (
            <p className="mt-3 max-w-2xl text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
              {summary}
            </p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
      </div>

      <dl className="mt-5 flex flex-wrap items-baseline gap-x-8 gap-y-2">
        <Fact label="State">
          <StateChip state={state} />
        </Fact>
        <Fact label="Next move">
          <span className="text-[13px] text-[var(--color-text)]">{nextMoveLine(work)}</span>
        </Fact>
        <Fact label="Last proof">
          <span
            className={cn(
              'text-[13px]',
              evidence.length ? 'text-[var(--color-text)]' : 'text-[var(--color-text-faint)]',
            )}
          >
            {proofSummary(evidence)}
          </span>
        </Fact>
      </dl>
    </header>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11.5px] text-[var(--color-text-faint)]">{label}</dt>
      <dd className="mt-1">{children}</dd>
    </div>
  );
}

/**
 * One piece of proof: what it is, where it came from, and when. The stored
 * confidence score stays on the server — it chooses the wording above, and
 * nothing more.
 */
export function EvidenceCard({ evidence }: { evidence: EvidenceLike }) {
  const rejected = evidence.trust === 'rejected';
  return (
    <li className={cn('flex gap-3 py-3', rejected && 'opacity-55 [&_a]:line-through [&_p]:line-through')}>
      <span
        aria-hidden
        className={cn(
          'mt-1.5 size-1.5 shrink-0 rounded-full',
          evidence.trust === 'confirmed'
            ? 'bg-[var(--color-success)]'
            : evidence.trust === 'rejected'
              ? 'bg-[var(--color-border-strong)]'
              : 'bg-[var(--color-accent)]',
        )}
      />
      <div className="min-w-0 flex-1">
        {evidence.url ? (
          <a
            href={evidence.url}
            target="_blank"
            rel="noreferrer"
            className="text-[13px] font-medium underline-offset-2 hover:underline"
          >
            {evidence.title}
          </a>
        ) : (
          <p className="text-[13px] font-medium">{evidence.title}</p>
        )}
        {evidence.summary ? (
          <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
            {evidence.summary}
          </p>
        ) : null}
        <p className="mt-1 text-[11.5px] text-[var(--color-text-faint)]">
          {evidenceSourceLabel(evidence.sourceKind)}
          {rejected ? ' · ruled out' : ''}
        </p>
      </div>
    </li>
  );
}

export interface AlbatrossRowData extends WorkStateInput {
  _id: string;
  title: string | null;
  rawText: string;
  areaName?: string | null;
  openQuestions: number;
}

export function albatrossTitle(item: { title: string | null; rawText: string }): string {
  const title = (item.title || '').trim();
  if (title) return title;
  const raw = item.rawText.trim().replace(/\s+/g, ' ');
  return raw.length > 96 ? `${raw.slice(0, 95)}…` : raw || 'Untitled';
}

/**
 * A list row. What needs the user is physically larger — hierarchy carries the
 * priority so the reader does not have to hunt for it.
 */
export function AlbatrossRow({ item, onOpen }: { item: AlbatrossRowData; onOpen: () => void }) {
  const state = workStateKey(item);
  const prominent = needsYou(item) || state === 'unresolved';
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'flex w-full items-start gap-3 px-4 text-left transition-colors hover:bg-[var(--color-bg-subtle)]',
        prominent ? 'py-4' : 'py-3',
      )}
    >
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block truncate',
            prominent ? 'font-serif text-[16px] font-semibold' : 'text-[13.5px] font-medium',
          )}
        >
          {albatrossTitle(item)}
        </span>
        <span className="mt-0.5 block text-[12px] text-[var(--color-text-muted)]">
          {nextMoveLine(item)}
          {item.areaName ? ` · ${item.areaName}` : ''}
        </span>
      </span>
      <StateChip state={state} />
    </button>
  );
}

export { latestProof };
