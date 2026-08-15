import { z } from 'zod';
import { generateObjectForCurrentUser } from '@/lib/ai/gateway';

/**
 * One question, asked everywhere evidence meets a requirement: does this
 * evidence satisfy this requirement? The lexical ranker is only a cheap
 * pre-filter. No automatic completion and no named-proof claim ships on
 * lexical overlap alone.
 */

export interface EvidenceGateInput {
  userId: string;
  workTitle: string;
  outcome?: string | null;
  /** The named proof requirement or the step's doneWhen sentence. */
  requirement: string;
  /** Subject, snippet, or body excerpt of the candidate evidence. */
  evidenceText: string;
}

export interface EvidenceGateVerdict {
  satisfies: boolean;
  reason: string;
  /** True when the check could not run. Callers must fail closed on this. */
  unavailable?: boolean;
}

export const evidenceGateVerdictSchema = z.object({
  satisfies: z.boolean(),
  reason: z.string().max(300),
});

const GATE_SYSTEM = `You judge whether one piece of evidence satisfies one requirement for one desired outcome.

Rules:
- Answer satisfies=true only when the evidence shows the requirement happened for this outcome.
- Shared common words are not evidence. Marketing mail about a related topic is not evidence.
- A confirmation, receipt, booking, or direct human reply about the requirement is evidence.
- When you are not sure, answer satisfies=false.
- Give one short reason in plain words.

Return the JSON object only.`;

interface EvidenceGateDependencies {
  generateObject: typeof generateObjectForCurrentUser;
}

const defaultDependencies: EvidenceGateDependencies = {
  generateObject: generateObjectForCurrentUser,
};

export async function evidenceSatisfies(
  input: EvidenceGateInput,
  dependencies: EvidenceGateDependencies = defaultDependencies,
): Promise<EvidenceGateVerdict> {
  const requirement = input.requirement.trim();
  const evidenceText = input.evidenceText.trim();
  if (!requirement || !evidenceText) {
    return { satisfies: false, reason: 'The requirement or the evidence is empty.' };
  }
  try {
    const { object } = await dependencies.generateObject<z.infer<typeof evidenceGateVerdictSchema>>({
      feature: 'albatross_evidence_gate',
      speed: 'classify',
      userId: input.userId,
      schema: evidenceGateVerdictSchema,
      system: GATE_SYSTEM,
      prompt: JSON.stringify({
        work: input.workTitle.slice(0, 300),
        outcome: (input.outcome || '').slice(0, 600) || undefined,
        requirement: requirement.slice(0, 600),
        evidence: evidenceText.slice(0, 4_000),
      }),
    });
    return {
      satisfies: object?.satisfies === true,
      reason: String(object?.reason || '').slice(0, 300),
    };
  } catch {
    // The gate being down never becomes a claim in either direction.
    return { satisfies: false, reason: 'The check did not run.', unavailable: true };
  }
}
