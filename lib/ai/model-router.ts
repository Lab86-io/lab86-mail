// Model-aware provider routing. Given a model id, decide which vendor it belongs
// to and translate the id between "direct" form (no vendor prefix, for the
// OpenAI/Anthropic SDKs) and "OpenRouter" form (vendor-prefixed). The gateway
// uses this to send OpenAI models to the OpenAI key, Anthropic models to the
// Anthropic key, and everything else to OpenRouter — whichever keys are
// configured, with OpenRouter as the universal catch-all.
//
// Pure functions only (no client/env deps) so they're unit-testable.

export type ModelVendor = 'openai' | 'anthropic' | 'other';

// Classify a model id by vendor. Handles both vendor-prefixed ids
// ("openai/gpt-5.5", "anthropic/claude-sonnet-4.6", "google/gemini-...") and
// bare ids ("gpt-5.5", "claude-sonnet-4.6").
export function classifyModel(modelName: string): ModelVendor {
  const m = (modelName || '').toLowerCase().trim();
  if (!m) return 'other';
  if (m.startsWith('openai/')) return 'openai';
  if (m.startsWith('anthropic/')) return 'anthropic';
  // Any other vendor prefix (google/, meta-llama/, x-ai/, mistralai/, …) is a
  // model only OpenRouter can serve.
  if (m.includes('/')) return 'other';
  // Bare ids — infer from the family name.
  if (m.startsWith('claude')) return 'anthropic';
  if (/^(gpt[-\d]|o\d|chatgpt|text-|davinci|babbage|dall-e|whisper|tts-|omni)/.test(m)) {
    return 'openai';
  }
  return 'other';
}

// Strip the OpenAI/Anthropic vendor prefix for use with the direct provider SDK
// (which expects bare ids like "gpt-5.5" / "claude-sonnet-4.6").
export function toDirectModelId(modelName: string): string {
  return (modelName || '').trim().replace(/^(openai|anthropic)\//i, '');
}

// Ensure a vendor prefix so OpenRouter can route the model. Already-prefixed ids
// pass through; bare OpenAI/Anthropic ids get their prefix; unknown bare ids are
// passed through best-effort.
export function toOpenRouterModelId(modelName: string): string {
  const name = (modelName || '').trim();
  if (!name || name.includes('/')) return name;
  const vendor = classifyModel(name);
  if (vendor === 'openai') return `openai/${name}`;
  if (vendor === 'anthropic') return `anthropic/${name}`;
  return name;
}
