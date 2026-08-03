'use client';

import { useConvexAuth, useMutation, useQuery } from 'convex/react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { cn } from '@/lib/utils';

interface OpenWork {
  _id: string;
  title: string;
  contract: { outcome: string; proofs: Array<{ id: string; what: string; satisfiedAt?: number }> } | null;
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
export function ProofOffer({ threadId, subject }: { threadId: string; subject: string }) {
  const { isAuthenticated } = useConvexAuth();
  const attach = useMutation(api.albatrossWorkV2.attachProof);
  const [dismissed, setDismissed] = useState(false);
  const [picking, setPicking] = useState(false);
  const [attached, setAttached] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = useQuery(api.albatrossWorkV2.openWorkForProof, isAuthenticated ? { limit: 8 } : 'skip') as
    | OpenWork[]
    | undefined;

  if (dismissed || !open?.length) return null;

  const use = async (work: OpenWork, proofId?: string, what?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await attach({
        workId: work._id as Id<'albatrossIntents'>,
        claim: what || `Something about "${work.title}" happened.`,
        title: subject,
        summary: 'You pointed at this message as proof.',
        sourceKind: 'mail_thread',
        sourceId: threadId,
        // A person pointing at a message is the strongest signal there is.
        trust: 'confirmed',
        proofId,
      });
      setAttached(work.title);
    } finally {
      setBusy(false);
    }
  };

  if (attached) {
    return (
      <div className="mx-5 mt-3 rounded-lg border-l-2 border-[var(--color-success)] bg-[var(--color-success-soft)] px-3.5 py-2.5">
        <p className="text-[12.5px]">
          Filed as proof for <span className="font-medium">{attached}</span>.
        </p>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'mx-5 mt-3 rounded-lg border border-l-2 border-dashed border-[var(--color-border-strong)]',
        'border-l-solid border-l-[var(--color-accent)] bg-[var(--color-bg-subtle)] px-3.5 py-2.5',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-[12.5px]">
          Does this settle something you are carrying?
          <span className="ml-1 text-[var(--color-text-muted)]">
            Albatross can file it as proof and close the thing when it is done.
          </span>
        </p>
        <div className="flex shrink-0 gap-1.5">
          <Button type="button" size="xs" variant="outline" onClick={() => setPicking((value) => !value)}>
            {picking ? 'Never mind' : 'Use as proof'}
          </Button>
          <Button type="button" size="xs" variant="ghost" onClick={() => setDismissed(true)}>
            Not related
          </Button>
        </div>
      </div>

      {picking ? (
        <ul className="mt-2.5 space-y-1 border-t border-dashed border-[var(--color-border)] pt-2.5">
          {open.map((work) => {
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
