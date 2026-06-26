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
  for (const message of messages as any[]) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (part?.type === 'tool-call' && part.toolCallId) callIds.add(part.toolCallId);
      if (part?.type === 'tool-result' && part.toolCallId) resultIds.add(part.toolCallId);
    }
  }
  const out: any[] = [];
  for (const message of messages as any[]) {
    if (!Array.isArray(message?.content)) {
      out.push(message);
      continue;
    }
    const content = message.content.filter((part: any) => {
      if (part?.type === 'tool-call') return resultIds.has(part.toolCallId);
      if (part?.type === 'tool-result') return callIds.has(part.toolCallId);
      return true;
    });
    // A message that was ONLY orphaned tool parts is dropped entirely.
    if (content.length === 0) continue;
    out.push(content.length === message.content.length ? message : { ...message, content });
  }
  return out as T[];
}
