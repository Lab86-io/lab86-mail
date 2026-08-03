'use client';

import { Check, Minus } from 'lucide-react';
import {
  CLOSE_WHEN_LABEL,
  CLOSE_WHEN_NOTE,
  contractStatusLine,
  contradicted,
  mayCloseAutomatically,
  type OutcomeContract,
  outcomeStanding,
} from '@/lib/albatross/contract';
import { type EvidenceLike, evidenceSourceLabel } from '@/lib/albatross/proof';
import { cn } from '@/lib/utils';

/**
 * The outcome contract, drawn as a ledger.
 *
 * Deliberately not another bordered card of list rows. A contract is a promise
 * with a spine: an accent rule down its left edge, each condition marked met or
 * outstanding, and the closing rule stated at the foot like a term. It should
 * read as the most considered object on the page, because it is the one that
 * decides whether Albatross may say something is finished.
 */
export function OutcomeContractCard({
  contract,
  evidence,
  onEdit,
}: {
  contract: OutcomeContract;
  evidence: EvidenceLike[];
  onEdit?: () => void;
}) {
  const conflict = contradicted(contract, evidence);
  const canClose = mayCloseAutomatically(contract, evidence);

  return (
    <section className="relative overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
      {/* The spine. One accent rule is the whole signature of this object. */}
      <span
        aria-hidden
        className={cn(
          'absolute inset-y-0 left-0 w-[3px]',
          canClose ? 'bg-[var(--color-success)]' : 'bg-[var(--color-accent)]',
        )}
      />
      <div className="py-4 pl-5 pr-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="text-[13px] font-semibold">What would settle this</h2>
          {onEdit ? (
            <button
              type="button"
              onClick={onEdit}
              className="text-[12px] text-[var(--color-text-muted)] underline-offset-2 hover:text-[var(--color-text)] hover:underline"
            >
              Correct this
            </button>
          ) : null}
        </div>
        <p className="mt-1 max-w-2xl font-serif text-[15px] leading-snug">{contract.outcome}</p>

        <ul className="mt-3 space-y-1.5">
          {contract.proofs.map((proof) => {
            const met = Boolean(proof.satisfiedAt);
            return (
              <li key={proof.id} className="flex items-start gap-2.5">
                <span
                  aria-hidden
                  className={cn(
                    'mt-[3px] grid size-4 shrink-0 place-items-center rounded-full border',
                    met
                      ? 'border-[var(--color-success)] bg-[var(--color-success)] text-white'
                      : 'border-dashed border-[var(--color-border-strong)] text-[var(--color-text-faint)]',
                  )}
                >
                  {met ? <Check className="size-2.5" /> : <Minus className="size-2.5" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      'block text-[13px]',
                      met ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)]',
                    )}
                  >
                    {proof.what}
                  </span>
                  {proof.satisfiedBy ? (
                    <span className="mt-0.5 block text-[11.5px] text-[var(--color-text-faint)]">
                      {proof.satisfiedBy}
                    </span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>

        <p className="mt-3 text-[12px] text-[var(--color-text-muted)]">
          {contractStatusLine(contract, evidence)}
        </p>

        {conflict ? (
          <p className="mt-2 rounded-lg border border-[var(--color-warning)]/30 bg-[var(--color-warning-soft)] px-3 py-2 text-[12px]">
            Something contradicts this: {conflict.title}. Albatross will not close it.
          </p>
        ) : null}

        {/* The closing rule, set like a term at the foot of an agreement. */}
        <div className="mt-3 border-t border-dashed border-[var(--color-border)] pt-2.5">
          <p className="text-[11.5px] text-[var(--color-text-faint)]">Albatross may close this</p>
          <p className="mt-0.5 text-[12.5px] font-medium">{CLOSE_WHEN_LABEL[contract.closeWhen]}</p>
          <p className="mt-0.5 text-[11.5px] text-[var(--color-text-muted)]">
            {CLOSE_WHEN_NOTE[contract.closeWhen]}
          </p>
        </div>
      </div>
    </section>
  );
}

/**
 * The proof timeline.
 *
 * A hairline spine with a node per piece of evidence, the strongest one filled.
 * Distinct from every list in the product on purpose: proof accumulates over
 * time toward a claim, and a flat list of rows cannot show that shape.
 */
export function ProofTimeline({
  evidence,
  contract,
}: {
  evidence: EvidenceLike[];
  contract?: OutcomeContract | null;
}) {
  if (!evidence.length) return null;
  // The contract clamps the claim: one confirmed receipt is not a confirmed
  // outcome while conditions remain outstanding.
  const standing = outcomeStanding(contract, evidence);
  const level = standing.level;
  const ordered = [...evidence].sort((a, b) => b.occurredAt - a.occurredAt);

  return (
    <section>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h2 className="text-[13px] font-semibold">Proof</h2>
        <p className="text-[11.5px] text-[var(--color-text-faint)]">
          What Albatross has seen that bears on whether this is done.
        </p>
      </div>

      <p
        className={cn(
          'mt-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px]',
          level === 'confirmed'
            ? 'bg-[var(--color-success-soft)] font-medium text-[var(--color-success)]'
            : level === 'likely'
              ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
              : 'border border-dashed border-[var(--color-border-strong)] text-[var(--color-text-muted)]',
        )}
      >
        {standing.label}
      </p>

      <ol className="relative mt-3 pl-5">
        {/* The spine. Everything hangs off it, newest at the top. */}
        <span aria-hidden className="absolute bottom-2 left-[5px] top-2 w-px bg-[var(--color-border)]" />
        {ordered.map((row) => {
          const strongest = row.trust === 'confirmed';
          const ruled = row.trust === 'rejected';
          return (
            <li key={row._id || `${row.sourceKind}-${row.occurredAt}`} className="relative py-2.5">
              <span
                aria-hidden
                className={cn(
                  'absolute -left-5 top-[15px] size-[11px] rounded-full border-2 border-[var(--color-bg-elevated)]',
                  strongest
                    ? 'bg-[var(--color-success)]'
                    : ruled
                      ? 'bg-[var(--color-border-strong)]'
                      : 'bg-[var(--color-accent)]',
                )}
              />
              <div className={cn('min-w-0', ruled && 'opacity-60')}>
                {row.claim ? (
                  <p className={cn('text-[13px] font-medium', ruled && 'line-through')}>{row.claim}</p>
                ) : null}
                {row.url ? (
                  <a
                    href={row.url}
                    target="_blank"
                    rel="noreferrer"
                    className={cn(
                      'text-[13px] underline-offset-2 hover:underline',
                      row.claim ? 'text-[var(--color-text-muted)]' : 'font-medium',
                    )}
                  >
                    {row.title}
                  </a>
                ) : (
                  <p
                    className={cn(
                      'text-[13px]',
                      row.claim ? 'text-[var(--color-text-muted)]' : 'font-medium',
                    )}
                  >
                    {row.title}
                  </p>
                )}
                {row.summary ? (
                  <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
                    {row.summary}
                  </p>
                ) : null}
                <p className="mt-1 text-[11.5px] text-[var(--color-text-faint)]">
                  {evidenceSourceLabel(row.sourceKind)}
                  {ruled ? ' · ruled out' : ''}
                  {row.limits ? ` · ${row.limits}` : ''}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
