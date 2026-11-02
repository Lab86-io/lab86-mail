// The dev previews of an approval: no network, and invented text only.

import { type LocalApprovalDecision, useApprovalDecisions } from './approval-decision';

/** One approval in the state the query names, and buttons that answer like the server. */
export function seedApprovalPreview(id: string, state: string | null): void {
  const at = Date.now();
  const seeds: Record<string, LocalApprovalDecision> = {
    deciding: { state: 'deciding', choice: 'approve', at },
    approved: { state: 'approved', at, goesOn: true },
    declined: { state: 'declined', at },
    failed: { state: 'failed', message: 'The action could not finish. Try again.', at },
  };
  useApprovalDecisions.setState((current) => {
    const decisions = { ...current.decisions };
    if (state && seeds[state]) decisions[id] = seeds[state];
    else delete decisions[id];
    return {
      decisions,
      call: async (name) => {
        await new Promise((resolve) => setTimeout(resolve, 900));
        return name === 'albatross_approve_action'
          ? { ok: true, followUp: { action: 'continued' } }
          : { ok: true };
      },
    };
  });
}
