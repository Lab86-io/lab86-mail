// How a connected tool and its items read on screen. Server ids stay as they
// are (`jira` holds the whole Atlassian sign-in); only the names change.

export const MCP_SERVER_LABELS: Record<string, string> = {
  github: 'GitHub',
  bitbucket: 'Bitbucket',
  jira: 'Jira',
  slack: 'Slack',
  granola: 'Granola',
};

// The names the server saves as `displayName` when the user gives none. A
// connection with one of these has no name of its own.
const DEFAULT_NAMES: Record<string, string[]> = {
  jira: ['Atlassian', 'Jira', 'Atlassian / Jira'],
};

export interface McpConnectionDisplayInput {
  server: string;
  authKind?: 'token' | 'oauth';
  displayName?: string;
  accountEmail?: string;
  workspaceName?: string;
}

export interface McpServerLabel {
  id: string;
  label: string;
}

export interface McpConnectionDisplay {
  /** The tool name: "Atlassian", "GitHub". */
  label: string;
  /** The name the user gave the connection, or null when it only repeats the tool name. */
  nickname: string | null;
  /** "acme, beta · ada@acme.com" from the last sync, or null before it. */
  identity: string | null;
}

// The Atlassian sign-in stores Confluence pages under the `jira` server.
export function isConfluencePage(item: { server: string; kind?: string | null }): boolean {
  return item.server === 'jira' && item.kind === 'page';
}

/** The source name for one connected item: "Confluence" for a page, else the tool name. */
export function mcpItemSourceLabel(item: { server: string; kind?: string | null }): string {
  if (isConfluencePage(item)) return 'Confluence';
  return MCP_SERVER_LABELS[item.server] ?? item.server;
}

/**
 * The tool name for one connection. The label from `/api/mcp/status` comes
 * first. Without it, an Atlassian sign-in reads "Atlassian" and an Atlassian
 * token reads "Jira".
 */
export function mcpConnectionLabel(
  connection: Pick<McpConnectionDisplayInput, 'server' | 'authKind'>,
  servers: readonly McpServerLabel[] = [],
): string {
  const fromServer = servers.find((server) => server.id === connection.server)?.label.trim();
  if (fromServer) return fromServer;
  if (connection.server === 'jira') return connection.authKind === 'oauth' ? 'Atlassian' : 'Jira';
  return MCP_SERVER_LABELS[connection.server] ?? connection.server;
}

function sameName(a: string, b: string) {
  const key = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  return key(a) === key(b);
}

export function mcpConnectionDisplay(
  connection: McpConnectionDisplayInput,
  servers: readonly McpServerLabel[] = [],
): McpConnectionDisplay {
  const label = mcpConnectionLabel(connection, servers);
  const name = connection.displayName?.trim() || '';
  const defaults = [
    label,
    MCP_SERVER_LABELS[connection.server] ?? '',
    ...(DEFAULT_NAMES[connection.server] ?? []),
  ];
  const nickname = name && !defaults.some((value) => value && sameName(name, value)) ? name : null;
  const parts = [connection.workspaceName?.trim(), connection.accountEmail?.trim()].filter(
    (part): part is string => Boolean(part),
  );
  const identity = [...new Set(parts)].join(' · ') || null;
  return { label, nickname, identity };
}
