import type { NormalizedMcpItem } from './servers';

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&amp;/gu, '&')
    .trim();
}

function xmlAttribute(source: string, name: string): string | undefined {
  const match = source.match(new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)')`, 'iu'));
  const value = match?.[1] ?? match?.[2];
  return value ? decodeXml(value) : undefined;
}

function xmlElement(source: string, name: string): string | undefined {
  const match = source.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'iu'));
  return match?.[1] ? decodeXml(match[1].replace(/^\s+|\s+$/gu, '')) : undefined;
}

/** Granola's live MCP emits XML-like text blocks rather than structuredContent. */
export function granolaMeetingsFromText(text: string): Array<Record<string, unknown>> {
  if (!/<meetings_data\b/iu.test(text)) return [];
  const meetings: Array<Record<string, unknown>> = [];
  for (const match of text.matchAll(/<meeting\b([^>]*)>([\s\S]*?)<\/meeting>/giu)) {
    const [, attributes = '', body = ''] = match;
    const id = xmlAttribute(attributes, 'id');
    if (!id) continue;
    const participants = xmlElement(body, 'known_participants')
      ?.split(/\s*,\s*|\n+/gu)
      .map((entry) => entry.trim())
      .filter(Boolean);
    const summary =
      xmlElement(body, 'summary') ||
      xmlElement(body, 'summarized_notes') ||
      xmlElement(body, 'private_notes');
    meetings.push({
      id,
      title: xmlAttribute(attributes, 'title'),
      date: xmlAttribute(attributes, 'date'),
      ...(participants?.length ? { attendees: participants } : {}),
      ...(summary ? { summary } : {}),
    });
  }
  return meetings;
}

export function granolaMeetingCountHint(result: unknown): number | null {
  const blocks = (result as any)?.content;
  if (!Array.isArray(blocks)) return null;
  for (const block of blocks) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    const count = block.text.match(/<meetings_data\b[^>]*\bcount="(\d+)"/iu)?.[1];
    if (count !== undefined) return Number(count);
  }
  return null;
}

export function granolaAccountInfo(result: unknown): { email?: string; workspaceName?: string } {
  const blocks = (result as any)?.content;
  if (!Array.isArray(blocks)) return {};
  for (const block of blocks) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    try {
      const parsed = JSON.parse(block.text);
      return {
        email: typeof parsed?.email === 'string' ? parsed.email : undefined,
        workspaceName:
          typeof parsed?.active_workspace?.display_name === 'string'
            ? parsed.active_workspace.display_name
            : undefined,
      };
    } catch {
      // Keep looking if a server adds a non-JSON informational block first.
    }
  }
  return {};
}

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
