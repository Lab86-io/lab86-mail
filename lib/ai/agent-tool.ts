import { tool } from 'ai';

// The OpenAI Responses API reads a function tool with no `strict` field as
// strict: each optional field becomes required, so the model fills all of them.
// A real deck call sent junk `blocks` and `sheet`, and the registry refused it.
// A document step wrote 12,000 tokens of arguments and made no call. With
// `strict: false` the same calls are clean and take seconds.
//
// The registry checks each call with its real schema, so the wire does not need
// strict mode. The field is safe on the other wires. Chat Completions and
// OpenRouter document it, and false is their default. The Anthropic provider
// sends it to a model with strict tools and drops it for other models.

/** The AI SDK `tool`, for the tools of the agent and of a run. */
export const agentTool = ((spec: any) => tool({ ...spec, strict: false })) as typeof tool;
