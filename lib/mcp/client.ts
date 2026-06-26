import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// A connected remote MCP session. Treat it as ephemeral — open it for one sync
// or one tool call, then close(); do not hold it across cron ticks.
export interface McpClientHandle {
  client: Client;
  toolNames: Set<string>;
  close: () => Promise<void>;
}

export async function connectMcp(serverUrl: string, token: string): Promise<McpClientHandle> {
  const client = new Client({ name: 'lab86-mail', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    // Non-interactive bearer auth: we already hold the user's token, so skip the
    // interactive OAuth discovery dance and pass it on every request.
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
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
