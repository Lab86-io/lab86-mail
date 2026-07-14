export interface DetachedMcpSourceInput {
  source: unknown;
  connectionId: string;
  server: string;
  externalId: string;
  itemTitle?: string;
  itemUrl?: string;
  fallbackTitle: string;
  disconnectedAt: number;
}

export function detachedMcpSource(input: DetachedMcpSourceInput): Record<string, unknown> | null {
  const source =
    input.source && typeof input.source === 'object' ? (input.source as Record<string, unknown>) : null;
  if (source?.kind !== 'mcp' || source.connectionId !== input.connectionId) return null;

  return {
    kind: 'external_snapshot',
    server: input.server,
    externalId: input.externalId,
    title:
      input.itemTitle || (typeof source.title === 'string' ? source.title : undefined) || input.fallbackTitle,
    url: input.itemUrl || (typeof source.url === 'string' ? source.url : undefined),
    disconnectedAt: input.disconnectedAt,
  };
}
