import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildAuthorizationHeader, type McpAuthMode } from './auth';

// A connected remote MCP session. Treat it as ephemeral — open it for one sync
// or one tool call, then close(); do not hold it across cron ticks.
export interface McpClientHandle {
  client: Client;
  toolNames: Set<string>;
  toolSchemas?: Map<string, unknown>;
  close: () => Promise<void>;
}

export async function connectMcp(
  serverUrl: string,
  token: string,
  authMode: McpAuthMode = 'bearer',
): Promise<McpClientHandle> {
  const client = new Client({ name: 'lab86-mail', version: '1.0.0' });
  const authorization = buildAuthorizationHeader(token, authMode);
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    // Non-interactive auth: we already hold the user's token, so skip the
    // interactive OAuth discovery dance and pass it on every request. The SDK
    // merges requestInit.headers into both its GET (SSE) and POST requests
    // (see _commonHeaders), so no authProvider is needed.
    requestInit: { headers: { Authorization: authorization } },
  });
  await client.connect(transport);

  let toolNames = new Set<string>();
  let toolSchemas = new Map<string, unknown>();
  try {
    const { tools } = await client.listTools();
    toolNames = new Set((tools || []).map((t: { name: string }) => t.name));
    toolSchemas = new Map(
      (tools || []).map((tool: { name: string; inputSchema?: unknown }) => [tool.name, tool.inputSchema]),
    );
  } catch {
    // Some servers gate tools/list; leave it empty and let callers attempt
    // their known tools anyway.
  }

  return {
    client,
    toolNames,
    toolSchemas,
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
