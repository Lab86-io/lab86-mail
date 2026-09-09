# GLM writer output compatibility

Schema-enforced writing remained unreliable on the real staging account, even
with an uninterrupted 175-second attempt. Staging was held from main promotion.

OpenRouter's GLM page advertises native JSON output without schema enforcement;
its endpoint metadata lists `structured_outputs` only for a subset of providers.
The installed OpenAI-compatible SDK maps `Output.object({schema})` to
`response_format: json_schema`, and `Output.json()` to `json_object`.

The GLM writer now requests the compatible JSON mode. Albatross still applies
the chapter-specific Zod schema, the exact codes present in that writing attempt,
ownership, source versions, consent, and run revision before publication. Other
models retain schema-enforced output. Model settings and source choices are not
changed, and no alternate model receives account evidence.

First real-account candidate result: ready in 39.2 seconds; final writing took
7.9 seconds and produced 1,608 characters with three citations, using the same
GLM model. Optional research timed out safely. This is evidence that output-mode
compatibility matters here, not a claim that model latency is guaranteed.

Tests inspect the requested output format for GLM and non-GLM models and reject
overlong JSON-mode prose before publication. Existing fabricated/retry citation,
revocation and cancellation tests remain in force. Repeated real-account and
live synthetic acceptance are required before main promotion.

References (2026-09-09):

- https://openrouter.ai/z-ai/glm-5.3-flash
- https://openrouter.ai/api/v1/models/z-ai/glm-5.3-flash/endpoints
- Installed SDK: `@ai-sdk/openai/src/chat/openai-chat-language-model.ts`
- Installed SDK: `ai/src/generate-text/output.ts`
