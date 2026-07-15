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

## Dogfood repair and chat research

The connected staging account exposed eight meetings, but Granola's live `list_meetings` response arrived as an XML-like text content block rather than JSON `structuredContent`. The original normalizer treated that successful response as an empty list and marked sync ready with zero items. Sync now parses that live shape, records Granola account/workspace identity, and treats a positive advertised meeting count with no normalized rows as an error instead of a successful empty sync.

The connector row uses Granola's official mark from `granola.ai`, and shows indexed item count plus the connected workspace/account so a successful OAuth connection can be distinguished from a successful data sync.

Chat motion was implemented directly with 5.6-sol. Existing Mobbin grounding in `AIBar.tsx` and `TeachAreas.tsx` covers quiet assistant surfaces and restrained streaming feedback (Linear Ask, Ferndesk, and Notion AI). Fresh Browserbase research checked Streamdown's progressive-render contract; assistant text now uses its word-separated `fadeIn` animation only while the newest response is streaming, then returns to static rendering. The short duration and stagger preserve the existing app density and respect the surrounding reduced-motion behavior.
