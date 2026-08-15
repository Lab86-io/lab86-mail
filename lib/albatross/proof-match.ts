import type { ContractProof } from './contract';

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'has',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'was',
  'with',
]);

export function proofTokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length > 2 && !STOP_WORDS.has(token)),
  );
}

export function proofMatchScore(needle: string, haystack: string): number {
  const wanted = proofTokens(needle);
  const available = proofTokens(haystack);
  if (!wanted.size || !available.size) return 0;
  let overlap = 0;
  for (const token of wanted) if (available.has(token)) overlap += 1;
  return overlap / Math.sqrt(wanted.size * available.size);
}

/** Choose a named requirement only when the evidence text gives us a real lexical reason. */
export function matchingProofId(proofs: ContractProof[], evidenceText: string): string | null {
  const outstanding = proofs.filter((proof) => !proof.satisfiedAt);
  const ranked = outstanding
    .map((proof) => ({ id: proof.id, score: proofMatchScore(proof.what, evidenceText) }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return ranked[0]?.score >= 0.16 ? ranked[0].id : null;
}

export interface ProofMatchWork {
  _id: string;
  title: string;
  outcome?: string | null;
  proofs?: ContractProof[];
}

/** Rank mail proof offers by the words shared with the Work outcome and named proof requirements. */
export function rankWorkForProof<T extends ProofMatchWork>(rows: T[], mailText: string): T[] {
  return (
    [...rows]
      .map((row) => ({
        row,
        score: Math.max(
          proofMatchScore(row.title, mailText),
          proofMatchScore(row.outcome || '', mailText),
          ...(row.proofs || []).map((proof) => proofMatchScore(proof.what, mailText)),
        ),
      }))
      // An open Albatross is not automatically a plausible match. Requiring a
      // real lexical overlap keeps unrelated mail from constantly asking to be
      // filed as proof.
      .filter(({ score }) => score >= 0.12)
      .sort((a, b) => b.score - a.score || a.row.title.localeCompare(b.row.title))
      .map(({ row }) => row)
  );
}

export interface MailProofCandidate<T extends ProofMatchWork> {
  work: T;
  proofId: string | null;
  proofWhat: string | null;
}

/** Rank plausible Work and choose only a lexically supported outstanding proof. */
export function proofCandidatesForMail<T extends ProofMatchWork>(
  rows: T[],
  mailText: string,
  limit = 5,
): Array<MailProofCandidate<T>> {
  return rankWorkForProof(rows, mailText)
    .slice(0, Math.max(0, limit))
    .map((work) => {
      const outstanding = (work.proofs || []).filter((proof) => !proof.satisfiedAt);
      const proofId = matchingProofId(outstanding, mailText);
      const proof = outstanding.find((row) => row.id === proofId);
      return {
        work,
        proofId: proof?.id || null,
        proofWhat: proof?.what || null,
      };
    });
}
