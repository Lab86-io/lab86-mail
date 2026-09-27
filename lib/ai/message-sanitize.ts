// Compaction (and any mid-turn failure) can leave the agent history with a
// tool-call whose result was dropped, or a tool-result whose call was dropped.
// OpenAI rejects such orphans outright ("No tool output found for function call
// …" → "Provider returned error"), and they're invalid for every strict
// provider. Drop both orphan directions so the converted model history is
// always valid, regardless of which model the request (or its failover) lands
// on. Pure function — unit-testable.
export function sanitizeToolPairs<T = any>(messages: T[]): T[] {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  // An approved or denied call has no result yet: the SDK runs it (or records
  // the denial) at the start of the next turn. Keep that call and its approval
  // pair. A call whose approval was never answered is an orphan like any other.
  const approvalCallIds = new Map<string, string>();
  const respondedApprovalIds = new Set<string>();
  for (const message of messages as any[]) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (part?.type === 'tool-call' && part.toolCallId) callIds.add(part.toolCallId);
      if (part?.type === 'tool-result' && part.toolCallId) resultIds.add(part.toolCallId);
      if (part?.type === 'tool-approval-request' && part.approvalId && part.toolCallId)
        approvalCallIds.set(part.approvalId, part.toolCallId);
      if (part?.type === 'tool-approval-response' && part.approvalId)
        respondedApprovalIds.add(part.approvalId);
    }
  }
  const approvedCallIds = new Set<string>();
  for (const [approvalId, toolCallId] of approvalCallIds)
    if (respondedApprovalIds.has(approvalId) && callIds.has(toolCallId)) approvedCallIds.add(toolCallId);
  const keptCall = (id: string) => resultIds.has(id) || approvedCallIds.has(id);
  const out: any[] = [];
  for (const message of messages as any[]) {
    if (!Array.isArray(message?.content)) {
      out.push(message);
      continue;
    }
    const content = message.content.filter((part: any) => {
      if (part?.type === 'tool-call') return keptCall(part.toolCallId);
      if (part?.type === 'tool-result') return callIds.has(part.toolCallId);
      if (part?.type === 'tool-approval-request') return keptCall(part.toolCallId);
      if (part?.type === 'tool-approval-response') {
        const toolCallId = approvalCallIds.get(part.approvalId);
        return !!toolCallId && keptCall(toolCallId);
      }
      return true;
    });
    // A message that was ONLY orphaned tool parts is dropped entirely.
    if (content.length === 0) continue;
    out.push(content.length === message.content.length ? message : { ...message, content });
  }
  return out as T[];
}
