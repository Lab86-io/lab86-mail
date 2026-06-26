import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// A connected remote MCP session. Treat it as ephemeral — open it for one sync
// or one tool call, then close(); do not hold it across cron ticks.
export interface McpClientHandle {
  client: Client;
  toolNames: Set<string>;
  close: () => Promise<void>;
}

// GitHub's edge (api.githubcopilot.com) rejects the request with
// "bad request: Authorization header is badly formatted" when the header VALUE
// is malformed — empty, a stray placeholder, double-"Bearer", or carrying a
// newline/whitespace from however the token was captured (e.g. piping
// `gh auth token`). The header is never validated against a JWT shape, so any
// non-conforming value trips it. Normalize defensively before we build it.
function sanitizeBearerToken(raw: string): string {
  let token = String(raw ?? '').trim();
  // Strip an accidental leading "Bearer " / "token " the caller may have stored.
  token = token.replace(/^(?:Bearer|token)\s+/i, '').trim();
  // Drop any embedded whitespace/newlines that would make the header value
  // illegal (RFC 7230 header values cannot contain CR/LF, and the GitHub edge
  // rejects internal spaces in the credential).
  token = token.replace(/\s+/g, '');
  if (!token) {
    throw new Error('MCP connection failed: the access token is empty after sanitizing.');
  }
  return token;
}

export async function connectMcp(serverUrl: string, token: string): Promise<McpClientHandle> {
  const client = new Client({ name: 'lab86-mail', version: '1.0.0' });
  const bearer = sanitizeBearerToken(token);
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    // Non-interactive bearer auth: we already hold the user's token, so skip the
    // interactive OAuth discovery dance and pass it on every request. The SDK
    // merges requestInit.headers into both its GET (SSE) and POST requests
    // (see _commonHeaders), so no authProvider is needed.
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
  });
  await client.connect(transport);

  let toolNames = new Set<string>();
  try {
    const { tools } = await client.listTools();
    toolNames = new Set((tools || []).map((t: { name: string }) => t.name));
  } catch {
    // Some servers gate tools/list; leave it empty and let callers attempt
    // their known tools anyway.
  }

  return {
    client,
    toolNames,
    close: async () => {
      try {
        await (transport as { terminateSession?: () => Promise<void> }).terminateSession?.();
      } catch {
        // best effort
      }
      try {
        await client.close();
      } catch {
        // best effort
      }
    },
  };
}

export async function callMcpTool(
  handle: McpClientHandle,
  name: string,
  args: Record<string, unknown>,
): Promise<any> {
  return handle.client.callTool({ name, arguments: args });
}
