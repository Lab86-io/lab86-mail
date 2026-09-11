'use client';

import { notFound } from 'next/navigation';
import { useState } from 'react';
import { ModelPicker } from '@/components/settings/ModelPicker';
import { useApplyThemeExtras } from '@/components/shell/ThemePanel';
import { buildModelCatalog, type OpenRouterLiveModel } from '@/lib/ai/model-catalog';

/* Dev-only harness: both pickers on a fixture catalog, so the grouping,
 * chips, and the older-models toggle can be checked without a signed-in
 * account. Not linked from anywhere; 404s outside development. */
export default function ModelPickerPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <ModelPickerPreviewInner />;
}

// A small live-shaped fixture: every curated id except GPT-5.1 Chat, which
// the merge then marks deprecated.
const LIVE_FIXTURE: OpenRouterLiveModel[] = [
  'openai/gpt-5.5',
  'openai/gpt-5.4',
  'openai/gpt-5.4-mini',
  'openai/gpt-5-nano',
  'openai/gpt-5.4-nano',
  'openai/gpt-5.6-luna',
  'anthropic/claude-opus-4.8',
  'anthropic/claude-sonnet-4.6',
  'anthropic/claude-haiku-4.5',
  'google/gemini-3.1-pro-preview',
  'google/gemini-3.5-flash',
  'google/gemini-3.5-flash-lite',
  'google/gemini-3.1-flash-lite',
  'x-ai/grok-4.3',
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash',
  'moonshotai/kimi-k2.6',
  'qwen/qwen3.6-plus',
  'qwen/qwen3-coder',
  'qwen/qwen3.6-flash',
  'meta-llama/llama-4-maverick',
  'meta-llama/llama-4-scout',
].map((id) => ({ id }));

function ModelPickerPreviewInner() {
  useApplyThemeExtras();
  const [model, setModel] = useState('openai/gpt-5.5');
  const [fastModel, setFastModel] = useState('openai/gpt-5-nano');
  const [retired, setRetired] = useState('openai/gpt-5.1-chat');
  const catalog = buildModelCatalog({ live: LIVE_FIXTURE, provider: 'openrouter' });
  const anthropicOnly = buildModelCatalog({ live: LIVE_FIXTURE, provider: 'anthropic' });
  return (
    <main className="mx-auto max-w-[760px] space-y-6 p-8">
      <h1 className="text-[15px] font-semibold">Model picker preview</h1>
      <div className="grid gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <span className="text-[12px] font-medium">Normal model</span>
          <ModelPicker
            slot="normal"
            value={model}
            onChange={setModel}
            catalog={catalog}
            allowCustomId
            defaultOpen
          />
        </div>
        <div className="space-y-1.5">
          <span className="text-[12px] font-medium">Fast model</span>
          <ModelPicker
            slot="fast"
            value={fastModel}
            onChange={setFastModel}
            catalog={catalog}
            allowCustomId
          />
        </div>
        <div className="space-y-1.5">
          <span className="text-[12px] font-medium">Retired saved model</span>
          <ModelPicker slot="normal" value={retired} onChange={setRetired} catalog={catalog} allowCustomId />
        </div>
        <div className="space-y-1.5">
          <span className="text-[12px] font-medium">Anthropic key only</span>
          <ModelPicker
            slot="normal"
            value="anthropic/claude-sonnet-4.6"
            onChange={() => {}}
            catalog={anthropicOnly}
          />
        </div>
      </div>
      <p className="text-[12px] text-[var(--color-text-muted)]">
        Chosen: {model} · {fastModel} · {retired}
      </p>
    </main>
  );
}
