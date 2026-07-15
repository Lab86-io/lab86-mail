import type { NormalizedMcpItem } from './servers';

export function granolaMeetingDetailArgs(
  inputSchema: unknown,
  meetingIds: string[],
): Record<string, unknown> | null {
  if (!meetingIds.length || !inputSchema || typeof inputSchema !== 'object') return null;
  const properties = (inputSchema as { properties?: Record<string, any> }).properties;
  if (!properties || typeof properties !== 'object') return null;
  const candidate = Object.entries(properties).find(([name]) =>
    /^(meeting_?ids?|ids?)$/iu.test(name.replace(/-/gu, '_')),
  );
  if (!candidate) return null;
  const [name, schema] = candidate;
  return { [name]: schema?.type === 'string' ? meetingIds[0] : meetingIds };
}

export function mergeGranolaMeetingDetails(
  listed: NormalizedMcpItem[],
  detailed: NormalizedMcpItem[],
): NormalizedMcpItem[] {
  const byId = new Map(listed.map((item) => [item.externalId, item]));
  for (const detail of detailed) {
    const prior = byId.get(detail.externalId);
    byId.set(detail.externalId, prior ? { ...prior, ...detail } : detail);
  }
  return [...byId.values()];
}
