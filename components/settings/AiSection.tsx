'use client';

// The AI section of Settings: mode cards, provider, the two model pickers,
// the API key, and billing. Extracted from app/settings/page.tsx so the
// pickers and the retired-model notice can be tested on their own.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Brain, Check, CreditCard, KeyRound, Trash2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import { Ring } from '@/components/loading-ui/ring';
import { ModelPicker } from '@/components/settings/ModelPicker';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  buildModelCatalog,
  type CatalogModel,
  defaultModelsFor,
  findCatalogModel,
  resolveSavedModel,
  type SavedModelSummary,
} from '@/lib/ai/model-catalog';
import type { Provider } from '@/lib/ai/model-options';

type AiSettingsResponse = {
  settings?: { mode?: 'lab86' | 'byok'; provider?: Provider; model?: string; fastModel?: string };
  key?: { provider: Provider; masked?: string } | null;
  requiresUserOpenRouterKey?: boolean;
  subscriptionsDisabled?: boolean;
  catalog?: CatalogModel[];
  catalogLive?: boolean;
  savedModels?: { normal: SavedModelSummary; fast: SavedModelSummary };
  usage?: {
    status?: string;
    paidPlan?: { monthlyUsd?: number; annualUsd?: number; byokMonthlyUsd?: number; byokAnnualUsd?: number };
  };
};

export function AiSection({ heading }: { heading: ReactNode }) {
  const qc = useQueryClient();
  const [aiMode, setAiMode] = useState<'lab86' | 'byok'>('byok');
  const [provider, setProvider] = useState<Provider>('openrouter');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [fastModel, setFastModel] = useState('');

  const {
    data: ai,
    error: loadError,
    refetch,
  } = useQuery({
    queryKey: ['ai-settings'],
    queryFn: async () => {
      const data = (await fetchJson('/api/ai/settings')) as AiSettingsResponse;
      const requireOpenRouter = Boolean(data.requiresUserOpenRouterKey);
      const nextMode = requireOpenRouter ? 'byok' : data.settings?.mode || 'lab86';
      const computedProvider = (
        nextMode === 'lab86' ? 'openrouter' : data.settings?.provider || data.key?.provider || 'openrouter'
      ) as Provider;
      const defaults = defaultModelsFor(computedProvider);
      setAiMode(nextMode);
      setProvider(computedProvider);
      // The saved id may be a direct vendor id; the picker works on canonical ids.
      setModel(data.savedModels?.normal.id || data.settings?.model || defaults.normal);
      setFastModel(data.savedModels?.fast.id || data.settings?.fastModel || defaults.fast);
      return data;
    },
  });
  // Saving before the server settings hydrate would persist these defaults
  // over the user's real configuration — gate every write on first load.
  const aiLoaded = Boolean(ai);

  const saveAi = useMutation({
    mutationFn: async () => {
      return postJson('/api/ai/settings', {
        mode: aiMode,
        provider: aiMode === 'lab86' ? 'openrouter' : provider,
        model: model || undefined,
        fastModel: fastModel || undefined,
        apiKey: aiMode === 'byok' ? apiKey || undefined : undefined,
      });
    },
    onSuccess: (data: { unknown?: boolean }) => {
      setApiKey('');
      toast.success(data?.unknown ? 'AI settings saved with a custom model id' : 'AI settings saved');
      qc.invalidateQueries({ queryKey: ['ai-settings'] });
    },
    onError: (err: any) => toast.error(err?.message || 'Could not save AI settings'),
  });

  const deleteKey = useMutation({
    // Delete the key that is actually stored, not whatever the selector
    // currently points at.
    mutationFn: async () => {
      const storedProvider = ai?.key?.provider;
      if (!storedProvider) throw new Error('No stored API key to remove.');
      return fetch(`/api/ai/settings?provider=${encodeURIComponent(storedProvider)}`, {
        method: 'DELETE',
      }).then(check);
    },
    onSuccess: () => {
      toast.success('API key removed');
      qc.invalidateQueries({ queryKey: ['ai-settings'] });
    },
    onError: (err: any) => toast.error(err?.message || 'Could not remove key'),
  });

  const checkout = useMutation({
    mutationFn: async () => postJson('/api/billing/checkout', {}),
    onSuccess: (data) => {
      if (data.url) window.location.href = data.url;
    },
    onError: (err: any) => toast.error(err?.message || 'Could not start checkout'),
  });
  const portal = useMutation({
    mutationFn: async () => postJson('/api/billing/portal', {}),
    onSuccess: (data) => {
      if (data.url) window.location.href = data.url;
    },
    onError: (err: any) => toast.error(err?.message || 'Could not open billing portal'),
  });

  const requireOpenRouter = Boolean(ai?.requiresUserOpenRouterKey);
  const subscriptionsDisabled = Boolean(ai?.subscriptionsDisabled);
  const paidPlan = ai?.usage?.paidPlan;
  const pricesPresent =
    typeof paidPlan?.monthlyUsd === 'number' &&
    typeof paidPlan?.annualUsd === 'number' &&
    typeof paidPlan?.byokMonthlyUsd === 'number' &&
    typeof paidPlan?.byokAnnualUsd === 'number';
  const priceLine = pricesPresent
    ? `Pro (hosted AI) is $${paidPlan.monthlyUsd}/mo or $${paidPlan.annualUsd}/yr · bring-your-own-key is $${paidPlan.byokMonthlyUsd}/mo or $${paidPlan.byokAnnualUsd}/yr.`
    : 'Two plans: hosted AI, or bring your own key for less.';

  // The catalog for the provider in play. The server builds it for the saved
  // provider; a provider switch in the form rebuilds it locally from the same
  // curated table so the picker never shows a model the key cannot serve.
  const effectiveProvider: Provider = aiMode === 'lab86' ? 'openrouter' : provider;
  const serverCatalog = ai?.catalog;
  const catalog = useMemoCatalog(serverCatalog, effectiveProvider);
  const allowCustomId = effectiveProvider === 'openrouter';

  const retired = [
    { slot: 'normal' as const, value: model, set: setModel },
    { slot: 'fast' as const, value: fastModel, set: setFastModel },
  ]
    .map((entry) => ({
      ...entry,
      resolution: resolveSavedModel(entry.value, catalog, { provider: effectiveProvider }),
    }))
    .filter((entry) => entry.resolution.deprecated && entry.resolution.replacement);

  function switchProvider(next: Provider) {
    setProvider(next);
    const defaults = defaultModelsFor(next);
    const nextCatalog = buildModelCatalog({ live: null, provider: next });
    // Keep a choice the new key can serve; otherwise fall back to its defaults.
    const keep = (value: string) => {
      const found = findCatalogModel(nextCatalog, value);
      return found && found.status !== 'unavailable' && found.status !== 'deprecated';
    };
    setModel((current) => (keep(current) ? current : defaults.normal));
    setFastModel((current) => (keep(current) ? current : defaults.fast));
  }

  return (
    <section>
      {heading}
      {loadError ? (
        <div role="alert" className="text-[13px] text-[var(--color-danger)]">
          Could not load AI settings.{' '}
          <button type="button" onClick={() => void refetch()}>
            Retry
          </button>
        </div>
      ) : !aiLoaded ? (
        <div className="flex items-center gap-2 rounded-xl border border-[var(--color-border)] px-4 py-6 text-[13px] text-[var(--color-text-muted)]">
          <Ring className="size-3.5" /> Loading your AI configuration…
        </div>
      ) : (
        <div className="space-y-4">
          {retired.map((entry) => (
            <div
              key={entry.slot}
              role="status"
              data-slot="retired-model-notice"
              className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--color-danger)] bg-[var(--color-bg-elevated)] px-4 py-3 text-[12.5px]"
            >
              <span className="min-w-0 flex-1">
                <span className="font-medium">{entry.resolution.model?.name}</span>
                <span className="text-[var(--color-text-muted)]">
                  {' '}
                  is retired. The {entry.slot === 'fast' ? 'fast' : 'normal'} slot now runs{' '}
                  {entry.resolution.replacement?.name} until you choose another model.
                </span>
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => entry.set(entry.resolution.replacement!.id)}
              >
                Use {entry.resolution.replacement?.name}
              </Button>
            </div>
          ))}
          <div className="grid gap-2.5 sm:grid-cols-2">
            <ModeCard
              active={aiMode === 'lab86'}
              disabled={requireOpenRouter}
              title="Lab86 AI"
              description="Included with Pro. Curated models, zero setup, budgeted for you."
              icon={<Brain className="size-4" />}
              onClick={() => setAiMode('lab86')}
            />
            <ModeCard
              active={aiMode === 'byok'}
              title="My own API key"
              description="Bring an OpenRouter, OpenAI, or Anthropic key. You pay your provider directly."
              icon={<KeyRound className="size-4" />}
              onClick={() => setAiMode('byok')}
            />
          </div>

          <div className="grid gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-4 shadow-[var(--shadow-soft)] sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Provider</Label>
              {aiMode === 'lab86' ? (
                <Input value="OpenRouter (Lab86 managed)" readOnly />
              ) : (
                <Select
                  value={provider}
                  onValueChange={(value) => switchProvider(value as Provider)}
                  disabled={requireOpenRouter}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openrouter">OpenRouter</SelectItem>
                    {!requireOpenRouter ? <SelectItem value="openai">OpenAI</SelectItem> : null}
                    {!requireOpenRouter ? <SelectItem value="anthropic">Anthropic</SelectItem> : null}
                  </SelectContent>
                </Select>
              )}
            </div>
            {aiMode === 'lab86' ? (
              <div className="self-end rounded-md bg-[var(--color-bg-muted)] px-3 py-2 text-[11.5px] text-[var(--color-text-muted)]">
                Lab86 AI runs through OpenRouter. Normal handles deep work; fast uses nano by default.
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label>API key</Label>
                <div className="flex gap-2">
                  <Input
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={ai?.key?.masked || 'Paste key to save or replace'}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {ai?.key ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-sm"
                      onClick={() => deleteKey.mutate()}
                      disabled={deleteKey.isPending}
                      title={`Remove stored ${ai.key.provider} key`}
                      className="shrink-0 self-center text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  ) : null}
                </div>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="ai-normal-model">Normal model</Label>
              <ModelPicker
                id="ai-normal-model"
                slot="normal"
                value={model}
                onChange={setModel}
                catalog={catalog}
                allowCustomId={allowCustomId}
              />
              <p className="text-[11px] text-[var(--color-text-muted)]">
                {findCatalogModel(catalog, model)?.note || 'Deep work: planning, drafts, the daily brief.'}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ai-fast-model">Fast model</Label>
              <ModelPicker
                id="ai-fast-model"
                slot="fast"
                value={fastModel}
                onChange={setFastModel}
                catalog={catalog}
                allowCustomId={allowCustomId}
              />
              <p className="text-[11px] text-[var(--color-text-muted)]">
                {findCatalogModel(catalog, fastModel)?.note ||
                  'Quick work: summaries, labels, short replies.'}
              </p>
            </div>
            <div className="sm:col-span-2">
              <Button
                type="button"
                onClick={() => saveAi.mutate()}
                disabled={!aiLoaded || saveAi.isPending}
                className="w-full sm:w-auto"
              >
                {saveAi.isPending ? <Ring className="size-3" /> : <Check className="size-3.5" />}
                Save AI settings
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-3 text-[12.5px] shadow-[var(--shadow-soft)]">
            <span className="text-[var(--color-text-muted)]">
              {subscriptionsDisabled
                ? 'Subscriptions are paused. AI usage requires your OpenRouter key.'
                : ai?.usage?.status === 'reduced_cost'
                  ? 'AI is using reduced-cost routing for the rest of this billing period.'
                  : ai?.usage?.status === 'exhausted'
                    ? 'AI chat is paused for this billing period — core mail automation continues.'
                    : priceLine}
            </span>
            {!subscriptionsDisabled ? (
              <span className="ml-auto flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => checkout.mutate()}
                  disabled={checkout.isPending}
                >
                  <CreditCard className="size-3.5" />
                  Upgrade
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => portal.mutate()}
                  disabled={portal.isPending}
                >
                  Manage
                </Button>
              </span>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * The server catalog carries live context and pricing for the saved
 * provider. When the form switches provider before a save, re-derive the
 * availability flags locally so the picker reflects the new key.
 */
function useMemoCatalog(serverCatalog: CatalogModel[] | undefined, provider: Provider): CatalogModel[] {
  const base = serverCatalog?.length ? serverCatalog : buildModelCatalog({ provider });
  const allowed = provider === 'openai' || provider === 'anthropic' ? provider : null;
  return base.map((entry) => {
    const blocked = allowed ? entry.provider !== allowed : false;
    if (blocked) return entry.status === 'unavailable' ? entry : { ...entry, status: 'unavailable' as const };
    if (entry.status === 'unavailable') {
      // Recompute from the vendor-neutral table for a model the server hid.
      return { ...entry, status: entry.catalogStatus ?? ('current' as const) };
    }
    return entry;
  });
}

function ModeCard({
  active,
  disabled,
  title,
  description,
  icon,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  title: string;
  description: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-xl border p-4 text-left transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
        active
          ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] shadow-[var(--shadow-soft)]'
          : 'border-[var(--color-border)] bg-[var(--color-bg-elevated)] hover:border-[var(--color-text-faint)]'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className={active ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'}>
          {icon}
        </span>
        <span className="text-[13.5px] font-semibold">{title}</span>
        {active ? (
          <Badge className="ml-auto bg-[var(--color-accent)] text-[10px] text-[var(--color-accent-foreground)]">
            Active
          </Badge>
        ) : null}
      </div>
      <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--color-text-muted)]">{description}</p>
    </button>
  );
}

async function fetchJson(url: string) {
  return check(await fetch(url, { cache: 'no-store' }));
}

async function postJson(url: string, body: any) {
  return check(
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function check(res: Response) {
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.ok === false) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}
