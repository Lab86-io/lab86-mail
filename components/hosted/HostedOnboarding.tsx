'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Brain, Check, KeyRound, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ProviderLogo, providerDisplayName } from '@/components/icons/provider-logos';
import { Ring } from '@/components/loading-ui/ring';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  type ModelOption,
  normalizeOpenRouterFastModel,
  normalizeOpenRouterPrimaryModel,
  OPENROUTER_FAST_MODEL_OPTIONS,
  OPENROUTER_PRIMARY_MODEL_OPTIONS,
  type Provider,
  setProviderForByok,
} from './ai-options';
import {
  ONBOARDING_DISMISSED_STORAGE_KEY,
  shouldExitWelcome,
  shouldRedirectToWelcome,
} from './onboarding-state';

interface NylasAccount {
  accountId: string;
  email: string;
  provider: 'google' | 'microsoft' | 'icloud' | 'imap';
  displayName?: string;
}

interface NylasCapability {
  provider: NylasAccount['provider'];
  label: string;
  visible: boolean;
  connectable: boolean;
  reason?: string;
}

interface NylasStatus {
  accounts?: NylasAccount[];
  capabilities?: NylasCapability[];
}

// First-run gate rendered inside the app shell: route only a settled,
// genuinely new account to /welcome. Returning and explicitly skipped users
// must never be interrupted by onboarding.
export function FirstRunRedirect() {
  const router = useRouter();
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  const {
    data: nylas,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['nylas-status'],
    queryFn: async () => fetchJson('/api/nylas/status') as Promise<NylasStatus>,
    retry: false,
  });
  useEffect(() => {
    setDismissed(window.localStorage.getItem(ONBOARDING_DISMISSED_STORAGE_KEY) === '1');
  }, []);
  useEffect(() => {
    const hasAccounts = (nylas?.accounts || []).length > 0;
    if (hasAccounts && !isLoading && !isError) {
      if (dismissed !== true) {
        window.localStorage.setItem(ONBOARDING_DISMISSED_STORAGE_KEY, '1');
        setDismissed(true);
      }
      return;
    }
    if (shouldRedirectToWelcome({ dismissed, hasAccounts, isLoading, isError })) {
      router.replace('/welcome');
    }
  }, [dismissed, isLoading, isError, nylas, router]);
  return null;
}

export function WelcomeFlow() {
  const qc = useQueryClient();
  const router = useRouter();
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  const [aiMode, setAiMode] = useState<'lab86' | 'byok'>('byok');
  const [provider, setProvider] = useState<Provider>('openrouter');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [fastModel, setFastModel] = useState('');

  const {
    data: nylas,
    isLoading: loadingAccounts,
    isError: accountsError,
    refetch: refetchAccounts,
  } = useQuery({
    queryKey: ['nylas-status'],
    queryFn: async () => fetchJson('/api/nylas/status') as Promise<NylasStatus>,
    retry: false,
  });
  // Seed the form state from the server only once; refetches (e.g. the
  // invalidation after a save) must not clobber edits the user is making.
  const aiFormSeeded = useRef(false);
  const { data: ai } = useQuery({
    queryKey: ['ai-settings'],
    queryFn: async () => {
      const data = await fetchJson('/api/ai/settings');
      if (aiFormSeeded.current) return data;
      aiFormSeeded.current = true;
      const requireOpenRouter = Boolean(data.requiresUserOpenRouterKey);
      const nextMode = requireOpenRouter ? 'byok' : data.settings?.mode || 'lab86';
      const nextProvider =
        nextMode === 'lab86' ? 'openrouter' : data.settings?.provider || data.key?.provider || 'openrouter';
      setAiMode(nextMode);
      setProvider(nextProvider);
      setModel(
        nextProvider === 'openrouter'
          ? normalizeOpenRouterPrimaryModel(data.settings?.model)
          : data.settings?.model || '',
      );
      setFastModel(
        nextProvider === 'openrouter'
          ? normalizeOpenRouterFastModel(data.settings?.fastModel)
          : data.settings?.fastModel || '',
      );
      return data;
    },
    retry: false,
  });
  const aiLoaded = Boolean(ai);

  const accounts = nylas?.accounts || [];
  const providerCapabilities = (nylas?.capabilities || []).filter((capability) => capability.visible);
  const icloud = providerCapabilities.find((capability) => capability.provider === 'icloud');
  const hasAccounts = accounts.length > 0;

  useEffect(() => {
    setDismissed(window.localStorage.getItem(ONBOARDING_DISMISSED_STORAGE_KEY) === '1');
  }, []);

  useEffect(() => {
    if (dismissed === true) {
      router.replace('/');
      return;
    }
    if (!shouldExitWelcome({ hasAccounts, isLoading: loadingAccounts })) return;
    window.localStorage.setItem(ONBOARDING_DISMISSED_STORAGE_KEY, '1');
    setDismissed(true);
    router.replace('/');
  }, [dismissed, hasAccounts, loadingAccounts, router]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('nylas_connected');
    if (!connected) return;
    toast.success(`${connected} connected`);
    qc.invalidateQueries({ queryKey: ['nylas-status'] });
    qc.invalidateQueries({ queryKey: ['accounts'] });
    params.delete('nylas_connected');
    const qs = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
  }, [qc]);

  const saveAi = useMutation({
    mutationFn: async () => {
      return postJson('/api/ai/settings', {
        mode: aiMode,
        provider: aiMode === 'lab86' ? 'openrouter' : provider,
        model:
          aiMode === 'lab86' || provider === 'openrouter'
            ? normalizeOpenRouterPrimaryModel(model)
            : undefined,
        fastModel:
          aiMode === 'lab86' || provider === 'openrouter'
            ? normalizeOpenRouterFastModel(fastModel)
            : undefined,
        apiKey: aiMode === 'byok' ? apiKey || undefined : undefined,
      });
    },
    onSuccess: () => {
      setApiKey('');
      toast.success('AI preference saved');
      qc.invalidateQueries({ queryKey: ['ai-settings'] });
    },
    onError: (err: any) => toast.error(err?.message || 'Could not save AI preference'),
  });

  const complete = () => {
    if (!hasAccounts) return;
    window.localStorage.setItem(ONBOARDING_DISMISSED_STORAGE_KEY, '1');
    setDismissed(true);
    router.replace('/');
  };

  const skip = () => {
    window.localStorage.setItem(ONBOARDING_DISMISSED_STORAGE_KEY, '1');
    setDismissed(true);
    router.replace('/');
  };

  const requireOpenRouter = Boolean(ai?.requiresUserOpenRouterKey);
  const primaryOptions = (ai?.modelOptions?.openrouter?.primary ||
    OPENROUTER_PRIMARY_MODEL_OPTIONS) as ModelOption[];
  const fastOptions = (ai?.modelOptions?.openrouter?.fast || OPENROUTER_FAST_MODEL_OPTIONS) as ModelOption[];
  const primaryModelDetail = primaryOptions.find((option) => option.id === model)?.detail;
  const fastModelDetail = fastOptions.find((option) => option.id === fastModel)?.detail;
  const showOpenRouterModels = aiMode === 'lab86' || provider === 'openrouter';

  return (
    <div className="relative w-full max-w-2xl overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-[var(--shadow-soft,0_8px_40px_rgb(0_0_0/0.08))]">
      <div className="flex flex-col items-start justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-6 pb-5 pt-6 sm:flex-row sm:gap-4">
        <div>
          <h1 className="text-[19px] font-semibold tracking-tight">Welcome to Lab86 Mail</h1>
          <p className="mt-1 text-[13px] text-[var(--color-text-muted)]">
            Two quick steps personalize your workspace. You can skip now and finish anytime in Settings.
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={skip}>
          Skip for now
        </Button>
      </div>

      <div className="space-y-7 px-6 py-6">
        {accountsError ? (
          <div className="flex items-start gap-2.5 rounded-xl border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5 px-4 py-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--color-danger)]" />
            <div className="min-w-0 text-[12.5px]">
              <div className="font-medium">The backend isn&apos;t reachable right now.</div>
              <div className="mt-0.5 text-[var(--color-text-muted)]">
                Your accounts and settings are safe — this screen will recover once the service is back.
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-2"
                onClick={() => refetchAccounts()}
              >
                Retry
              </Button>
            </div>
          </div>
        ) : null}

        {/* ---- Step 1: mailboxes -------------------------------------- */}
        <section>
          <StepHeading
            step={1}
            done={hasAccounts}
            title="Connect your mail"
            blurb="Each mailbox is downloaded into your private search index — search stays instant."
          />
          <div className="mt-3 space-y-2">
            {accounts.map((account) => (
              <div
                key={account.accountId || account.email}
                className="flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3.5 py-2.5"
              >
                <div className="grid size-8 shrink-0 place-items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
                  <ProviderLogo provider={account.provider} className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">
                    {account.displayName || account.email}
                  </div>
                  <div className="truncate text-[11px] text-[var(--color-text-muted)]">
                    {account.email} · {providerDisplayName(account.provider)}
                  </div>
                </div>
                <Check className="size-4 shrink-0 text-emerald-500" aria-label="Connected" />
              </div>
            ))}
            {!accounts.length && !loadingAccounts && !accountsError ? (
              <div className="rounded-xl border border-dashed border-[var(--color-border)] px-4 py-4 text-center text-[12.5px] text-[var(--color-text-muted)]">
                Nothing connected yet — pick a provider below.
              </div>
            ) : null}
            {loadingAccounts ? (
              <div className="flex items-center gap-2 rounded-xl border border-[var(--color-border)] px-4 py-3 text-[12.5px] text-[var(--color-text-muted)]">
                <Ring className="size-3.5" /> Checking connected mailboxes…
              </div>
            ) : null}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {providerCapabilities.map((capability) => (
              <Button
                key={capability.provider}
                asChild={capability.connectable}
                disabled={!capability.connectable}
                variant="outline"
                size="sm"
                className="gap-2"
              >
                {capability.connectable ? (
                  <a href={`/api/nylas/connect?provider=${capability.provider}&redirectTo=/welcome`}>
                    <ProviderLogo provider={capability.provider} className="size-3.5" />
                    {capability.label}
                    <Plus className="size-3 text-[var(--color-text-faint)]" />
                  </a>
                ) : (
                  <span>
                    <ProviderLogo provider={capability.provider} className="size-3.5 opacity-50" />
                    {capability.label}
                  </span>
                )}
              </Button>
            ))}
          </div>
          {icloud ? (
            <p className="mt-2 text-[11px] text-[var(--color-text-muted)]">
              {icloud.connectable
                ? 'iCloud needs an app-specific password — create one at appleid.apple.com first.'
                : icloud.reason}
            </p>
          ) : null}
        </section>

        {/* ---- Step 2: AI --------------------------------------------- */}
        <section>
          <StepHeading
            step={2}
            done={false}
            title="Choose how AI runs"
            blurb="Summaries, triage, drafts, and the daily brief — hosted by Lab86 or on your own key."
          />
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <ModeCard
              active={aiMode === 'lab86'}
              disabled={requireOpenRouter}
              icon={<Brain className="size-4" />}
              title="Lab86 AI"
              description="Included with Pro. Curated models, zero setup, budgeted automatically."
              onClick={() => setAiMode('lab86')}
            />
            <ModeCard
              active={aiMode === 'byok'}
              icon={<KeyRound className="size-4" />}
              title="My own API key"
              description="OpenRouter, OpenAI, or Anthropic — you pay your provider directly."
              onClick={() => setAiMode('byok')}
            />
          </div>

          <div className="mt-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              {aiMode === 'lab86' ? (
                <div className="space-y-1.5">
                  <Label>Provider</Label>
                  <Input value="OpenRouter (Lab86 managed)" readOnly />
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Label>Provider</Label>
                  <Select
                    value={provider}
                    onValueChange={(value) =>
                      setProviderForByok(value as Provider, setProvider, setModel, setFastModel)
                    }
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
                </div>
              )}
              {aiMode === 'byok' ? (
                <div className="space-y-1.5">
                  <Label>API key</Label>
                  <Input
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={ai?.key?.masked || 'Paste key'}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
              ) : (
                <div className="self-end rounded-md bg-[var(--color-bg-muted)] px-3 py-2 text-[11.5px] text-[var(--color-text-muted)]">
                  Lab86 AI runs through OpenRouter. Normal handles deep work; fast uses nano by default.
                </div>
              )}
              <div className="space-y-1.5">
                <Label>Normal model</Label>
                {showOpenRouterModels ? (
                  <Select value={model} onValueChange={setModel}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {primaryOptions.map((option) => (
                        <SelectItem key={option.id} value={option.id}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input value="Provider default" readOnly />
                )}
                {showOpenRouterModels && primaryModelDetail ? (
                  <p className="text-[11px] text-[var(--color-text-muted)]">{primaryModelDetail}</p>
                ) : null}
              </div>
              <div className="space-y-1.5">
                <Label>Fast model</Label>
                {showOpenRouterModels ? (
                  <Select value={fastModel} onValueChange={setFastModel}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {fastOptions.map((option) => (
                        <SelectItem key={option.id} value={option.id}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input value="Provider default" readOnly />
                )}
                {showOpenRouterModels && fastModelDetail ? (
                  <p className="text-[11px] text-[var(--color-text-muted)]">{fastModelDetail}</p>
                ) : null}
              </div>
            </div>
          </div>
        </section>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-6 py-4">
        <p className="text-[11.5px] text-[var(--color-text-muted)]">
          {ai?.usage?.status === 'exhausted'
            ? 'Your Lab86 AI budget is used up for this period — AI chat is paused.'
            : ai?.usage?.status === 'reduced_cost'
              ? 'AI is using reduced-cost routing for the rest of this period.'
              : 'You can change all of this later in Settings.'}
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => saveAi.mutate()}
            disabled={!aiLoaded || saveAi.isPending}
          >
            {saveAi.isPending ? <Ring className="size-3" /> : null}
            Save AI
          </Button>
          <Button
            type="button"
            onClick={async () => {
              try {
                await saveAi.mutateAsync();
                complete();
              } catch {}
            }}
            disabled={!hasAccounts || !aiLoaded || saveAi.isPending}
          >
            Continue
            <ArrowRight className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function StepHeading({
  step,
  done,
  title,
  blurb,
}: {
  step: number;
  done: boolean;
  title: string;
  blurb: string;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <Badge
        variant={done ? 'default' : 'outline'}
        className={cn('mt-0.5 size-6 justify-center rounded-full p-0', done && 'bg-emerald-500')}
      >
        {done ? <Check className="size-3.5" /> : step}
      </Badge>
      <div>
        <h3 className="text-[14px] font-semibold tracking-tight">{title}</h3>
        <p className="mt-0.5 text-[12px] text-[var(--color-text-muted)]">{blurb}</p>
      </div>
    </div>
  );
}

function ModeCard({
  active,
  disabled,
  icon,
  title,
  description,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'rounded-xl border p-3.5 text-left transition-all disabled:cursor-not-allowed disabled:opacity-50',
        active
          ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] shadow-[var(--shadow-soft)]'
          : 'border-[var(--color-border)] bg-[var(--color-bg-elevated)] hover:border-[var(--color-text-faint)]',
      )}
    >
      <div className="flex items-center gap-2">
        <span className={active ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'}>
          {icon}
        </span>
        <span className="text-[13px] font-semibold">{title}</span>
        {active ? (
          <Badge className="ml-auto bg-[var(--color-accent)] text-[10px] text-[var(--color-accent-foreground)]">
            Selected
          </Badge>
        ) : null}
      </div>
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">{description}</p>
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
