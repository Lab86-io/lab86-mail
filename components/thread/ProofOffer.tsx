'use client';

import { useConvexAuth, useQuery } from 'convex/react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { api } from '@/convex/_generated/api';
import { type MailProofCandidate, proofCandidatesForMail } from '@/lib/albatross/proof-match';
import { cn } from '@/lib/utils';

export interface OpenWork {
  _id: string;
  title: string;
  contract: { outcome: string; proofs: Array<{ id: string; what: string; satisfiedAt?: number }> } | null;
}

interface MailProofRequest {
  work: OpenWork;
  threadId: string;
  accountId: string;
  subject: string;
  snippet?: string | null;
  proofId?: string;
  proofWhat?: string;
  timezone: string;
}

/** File user-selected mail evidence without accepting client-authored trust. */
export async function submitMailProof(
  input: MailProofRequest,
  fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
) {
  const response = await fetcher(`/api/albatross/work/${encodeURIComponent(input.work._id)}/proof`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      claim: input.proofWhat || `Something about "${input.work.title}" happened.`,
      title: input.subject,
      summary: input.snippet || 'You pointed at this message as proof.',
      sourceKind: 'mail_thread',
      sourceId: input.threadId,
      accountId: input.accountId,
      proofId: input.proofId,
      timezone: input.timezone,
    }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error || 'Could not attach this proof.');
  return result;
}

/** The exact tentative claim shown before the user confirms a mail match. */
export function ProofOfferMatchSummary({ match }: { match: MailProofCandidate<OpenWork> }) {
  return (
    <>
      Does this settle something you are carrying? Albatross matched it to{' '}
      {match.proofWhat ? `“${match.proofWhat}”` : 'the outcome'} for{' '}
      <span className="font-medium">{match.work.title}</span>.
      <span className="ml-1 text-[var(--color-text-muted)]">
        Albatross can file it as proof and close the thing when it is done.
      </span>
    </>
  );
}

/**
 * Mail carries proof.
 *
 * This is the strongest single feature in the product and the one nobody can
 * copy without a real mail client: most confirmations that a real-life thing
 * actually happened arrive by email. "Your policy is active." "Your refund has
 * been issued." "Thanks, got it."
 *
 * Visually it is its own object — an inset band with a dashed leading edge,
 * clearly an offer from Albatross rather than part of the message. It never
 * asserts; it asks, and it is dismissible in one click.
 */
export function ProofOffer({
  threadId,
  accountId,
  subject,
  snippet,
}: {
  threadId: string;
  accountId: string;
  subject: string;
  snippet?: string | null;
}) {
  const { isAuthenticated } = useConvexAuth();
  const [dismissed, setDismissed] = useState(false);
  const [picking, setPicking] = useState(false);
  const [attached, setAttached] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = useQuery(api.albatrossWorkV2.openWorkForProof, isAuthenticated ? { limit: 8 } : 'skip') as
    | OpenWork[]
    | undefined;
  const matches = useMemo(
    () =>
      proofCandidatesForMail(
        (open || []).map((work) => ({
          ...work,
          outcome: work.contract?.outcome,
          proofs: work.contract?.proofs,
        })),
        `${subject} ${snippet || ''}`,
      ),
    [open, snippet, subject],
  );

  if (dismissed || !matches.length) return null;

  const use = async (work: OpenWork, proofId?: string, what?: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await submitMailProof({
        work,
        threadId,
        accountId,
        subject,
        snippet,
        proofId,
        proofWhat: what,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      setAttached(work.title);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not attach this proof.');
    } finally {
      setBusy(false);
    }
  };
  const suggestedMatch = matches[0];
  const suggested = suggestedMatch.work;

  if (attached) {
    return (
      <div className="mt-4 rounded-lg border-l-2 border-[var(--color-success)] bg-[var(--color-success-soft)] px-3.5 py-2.5">
        <p className="text-[12.5px]">
          Filed as proof for <span className="font-medium">{attached}</span>.
        </p>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'mt-4 rounded-lg border border-l-2 border-dashed border-[var(--color-border-strong)]',
        // Tailwind has no per-side border-style utility; without the arbitrary
        // property the accent leading edge inherits `dashed` and the whole
        // card reads as a dropzone instead of an offer with a solid spine.
        '[border-left-style:solid] border-l-[var(--color-accent)] bg-[var(--color-bg-subtle)] px-3.5 py-2.5',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-[12.5px]">
          <ProofOfferMatchSummary match={suggestedMatch} />
        </p>
        <div className="flex shrink-0 gap-1.5">
          <Button type="button" size="xs" variant="outline" onClick={() => setPicking((value) => !value)}>
            {picking ? 'Never mind' : 'Choose another'}
          </Button>
          <Button
            type="button"
            size="xs"
            disabled={busy}
            onClick={() =>
              void use(suggested, suggestedMatch.proofId || undefined, suggestedMatch.proofWhat || undefined)
            }
          >
            {busy ? 'Filing proof…' : 'Yes, use as proof'}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => setDismissed(true)}
            // A dismissal must look pressable at rest, not only on hover; the
            // underline gives it link affordance without competing with the
            // outlined primary next to it.
            className="underline decoration-[var(--color-border-strong)] underline-offset-4 hover:decoration-current"
          >
            Not related
          </Button>
        </div>
      </div>

      {error ? <p className="mt-2 text-[11.5px] text-[var(--color-text-muted)]">{error}</p> : null}

      {picking ? (
        <ul className="mt-2.5 space-y-1 border-t border-dashed border-[var(--color-border)] pt-2.5">
          {matches.map(({ work }) => {
            const outstanding = (work.contract?.proofs || []).filter((proof) => !proof.satisfiedAt);
            return (
              <li key={work._id}>
                <p className="text-[12px] font-medium">{work.title}</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {outstanding.length ? (
                    outstanding.map((proof) => (
                      <button
                        key={proof.id}
                        type="button"
                        disabled={busy}
                        onClick={() => void use(work, proof.id, proof.what)}
                        className="rounded-full border border-[var(--color-border)] px-2.5 py-1 text-[11.5px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
                      >
                        {proof.what}
                      </button>
                    ))
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void use(work)}
                      className="rounded-full border border-[var(--color-border)] px-2.5 py-1 text-[11.5px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
                    >
                      File it against this
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
