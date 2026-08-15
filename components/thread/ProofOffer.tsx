'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** One candidate returned by /api/albatross/proof-matches. */
export interface ProofMatchCandidate {
  workId: string;
  workTitle: string;
  outcome?: string | null;
  proofId: string | null;
  proofWhat: string | null;
  gate: 'confirmed' | 'unchecked';
  outstanding: Array<{ id: string; what: string }>;
}

interface MailProofRequest {
  workId: string;
  workTitle: string;
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
  const response = await fetcher(`/api/albatross/work/${encodeURIComponent(input.workId)}/proof`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      claim: input.proofWhat || `Something about "${input.workTitle}" happened.`,
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

/** Ask the server for gated candidates. The offer stays silent on any failure. */
export async function loadProofMatches(
  input: { subject: string; snippet?: string | null; accountId: string; providerThreadId: string },
  fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<ProofMatchCandidate[]> {
  const response = await fetcher('/api/albatross/proof-matches', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok || !Array.isArray(body.candidates)) return [];
  return body.candidates as ProofMatchCandidate[];
}

/** The exact tentative claim shown before the user confirms a mail match. */
export function ProofOfferMatchSummary({ match }: { match: ProofMatchCandidate }) {
  return (
    <>
      Does this settle something you are carrying? Albatross matched it to{' '}
      {match.proofWhat ? `“${match.proofWhat}”` : 'the outcome'} for{' '}
      <span className="font-medium">{match.workTitle}</span>.
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
 * The server decides which matches are worth asking about: the thread's mail
 * class blocks marketing and code mail outright, and a model check refutes
 * word-overlap coincidences before anything renders here.
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
  const [matches, setMatches] = useState<ProofMatchCandidate[]>([]);
  const [dismissed, setDismissed] = useState(false);
  const [picking, setPicking] = useState(false);
  const [attached, setAttached] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMatches([]);
    setAttached(null);
    setDismissed(false);
    setPicking(false);
    if (!subject.trim() && !snippet?.trim()) return;
    void loadProofMatches({ subject, snippet, accountId, providerThreadId: threadId })
      .then((candidates) => {
        if (!cancelled) setMatches(candidates);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [threadId, accountId, subject, snippet]);

  if (dismissed || !matches.length) return null;

  const use = async (match: ProofMatchCandidate, proofId?: string, what?: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await submitMailProof({
        workId: match.workId,
        workTitle: match.workTitle,
        threadId,
        accountId,
        subject,
        snippet,
        proofId,
        proofWhat: what,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      setAttached(match.workTitle);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not attach this proof.');
    } finally {
      setBusy(false);
    }
  };
  const suggestedMatch = matches[0];

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
              void use(suggestedMatch, suggestedMatch.proofId || undefined, suggestedMatch.proofWhat || undefined)
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
          {matches.map((match) => (
            <li key={match.workId}>
              <p className="text-[12px] font-medium">{match.workTitle}</p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {match.outstanding.length ? (
                  match.outstanding.map((proof) => (
                    <button
                      key={proof.id}
                      type="button"
                      disabled={busy}
                      onClick={() => void use(match, proof.id, proof.what)}
                      className="rounded-full border border-[var(--color-border)] px-2.5 py-1 text-[11.5px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
                    >
                      {proof.what}
                    </button>
                  ))
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void use(match)}
                    className="rounded-full border border-[var(--color-border)] px-2.5 py-1 text-[11.5px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
                  >
                    File it against this
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
