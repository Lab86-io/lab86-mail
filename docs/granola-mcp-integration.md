# Granola MCP Integration

Date: 2026-07-15

Implementation path: 5.6-sol direct, with Browserbase research and live protocol verification.

## Official contract

Granola exposes a hosted Streamable HTTP MCP server at `https://mcp.granola.ai/mcp`. Its documented tools cover meeting search, folders, meeting details, transcripts, and account information. Authentication is browser OAuth only; Granola does not provide an MCP API-key or service-account path.

Official reference: [Granola MCP integration](https://docs.granola.ai/help-center/sharing/integrations/mcp)

Browserbase verified the live protected-resource and authorization-server metadata. The server advertises dynamic client registration, authorization-code PKCE, refresh tokens, an `mcp` resource scope, and the `https://mcp-auth.granola.ai/oauth2/authorize` authorization endpoint.

## Implementation

- Settings presents a browser-OAuth Connect action rather than a token field.
- The MCP SDK performs protected-resource discovery, authorization-server discovery, dynamic client registration, and PKCE generation.
- Short-lived OAuth transaction state is encrypted and stored server-side in Convex, bound to the signed-in Clerk user, consumed once, and swept after expiry.
- Access tokens, refresh tokens, and dynamic client information are encrypted before Convex persistence.
- Expiring tokens refresh before sync; rotated refresh tokens replace the old encrypted value atomically.
- The callback validates state and user ownership, stores the connection, and immediately runs the first sync.
- Sync lists meetings and, when Granola advertises the `get_meetings` input schema, enriches them with available meeting notes without guessing an undocumented argument shape.
- Granola meeting evidence participates in connected search, Daily Briefs, and proactive Area matching under the same candidate/verification rules as other MCP evidence.

Granola plan and workspace visibility still governs what Lab86 can read. Basic accounts may expose only recent personal notes, while paid or Enterprise configurations can expose broader meeting and transcript access.
