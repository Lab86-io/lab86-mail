# Granola MCP Integration Plan

Date: 2026-07-15

## What Granola supports

Granola exposes a hosted Streamable HTTP MCP server at `https://mcp.granola.ai/mcp`. Its documented tools cover meeting search, folders, meeting details, transcripts, and account information. Authentication is browser OAuth only; Granola does not provide an MCP API-key or service-account path.

Official reference: [Granola MCP integration](https://docs.granola.ai/help-center/sharing/integrations/mcp)

## Why it is not a token-form connector

Lab86's current connection screen and `/api/mcp/connect` route accept user-pasted tokens. The schema anticipates an `oauth` auth kind, but the application does not yet implement OAuth discovery, dynamic client registration, PKCE state, callback exchange, refresh, or encrypted OAuth-client metadata. Presenting Granola in the existing token form would therefore advertise a connection that Granola cannot complete.

## Production implementation slice

1. Add a generic hosted-MCP OAuth flow using the MCP SDK's `OAuthClientProvider` and Streamable HTTP transport.
2. Persist short-lived state and PKCE verifier data server-side; validate the signed-in user again on callback.
3. Encrypt access tokens, refresh tokens, and dynamically registered client credentials; never expose them to the browser or Convex logs.
4. Refresh expired access tokens during sync and atomically rotate stored refresh tokens.
5. Register Granola with its official endpoint and query tools, normalizing meetings and transcripts into MCP evidence.
6. Add a browser-OAuth “Connect Granola” action, callback/error states, disconnect/revoke behavior, and focused auth/sync tests.
7. Respect Granola workspace and plan visibility: only data available to the authorizing account should enter search, briefs, or Areas.

This should be implemented as shared OAuth infrastructure, then used by Granola, rather than as a Granola-only collection of routes. That keeps state validation, token rotation, and callback security consistent for future OAuth-only MCP servers.
