'use client';

import { UserButton } from '@clerk/nextjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CreditCard, KeyRound, Link2, LogOut, MailPlus, Settings2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  LAB86_MODEL_FAMILIES,
  type Lab86ModelFamily,
  normalizeOpenRouterFastModel,
  normalizeOpenRouterPrimaryModel,
  OPENROUTER_FAST_MODEL_OPTIONS,
  OPENROUTER_PRIMARY_MODEL_OPTIONS,
  type Provider,
  resolveLab86Family,
  setProviderForByok,
} from './ai-options';

export function HostedSettingsButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="grid h-7 w-7 place-items-center rounded-md text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text)]"
        title="Accounts and AI"
      >
        <Settings2 className="h-3.5 w-3.5" />
      </button>
      <HostedSettings open={open} onOpenChange={setOpen} />
    </>
  );
}

function HostedSettings({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient();
  const [aiMode, setAiMode] = useState<'lab86' | 'byok'>('byok');
  const [lab86Family, setLab86Family] = useState<Lab86ModelFamily>('openai');
  const [provider, setProvider] = useState<Provider>('openrouter');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [fastModel, setFastModel] = useState('');

  const { data: nylas } = useQuery({
    queryKey: ['nylas-status', open],
    queryFn: async () => fetchJson('/api/nylas/status'),
    enabled: open,
  });
  const { data: ai } = useQuery({
    queryKey: ['ai-settings', open],
    queryFn: async () => {
      const data = await fetchJson('/api/ai/settings');
      const requireOpenRouter = Boolean(data.requiresUserOpenRouterKey);
      const computedProvider = (
        requireOpenRouter ? 'openrouter' : data.settings?.provider || data.key?.provider || 'openrouter'
      ) as Provider;
      setAiMode(requireOpenRouter ? 'byok' : data.settings?.mode || 'lab86');
      setProvider(computedProvider);
      setModel(
        computedProvider === 'openrouter'
          ? normalizeOpenRouterPrimaryModel(data.settings?.model)
          : data.settings?.model || '',
      );
      setFastModel(
        computedProvider === 'openrouter'
          ? normalizeOpenRouterFastModel(data.settings?.fastModel)
          : data.settings?.fastModel || '',
      );
      setLab86Family(resolveLab86Family(data.settings?.model, data.settings?.fastModel));
      return data;
    },
    enabled: open,
  });

  const saveAi = useMutation({
    mutationFn: async () => {
      const selected = LAB86_MODEL_FAMILIES[lab86Family];
      return postJson('/api/ai/settings', {
        mode: aiMode,
        provider: aiMode === 'lab86' ? 'openrouter' : provider,
        model:
          aiMode === 'lab86'
            ? selected.primary
            : provider === 'openrouter'
              ? normalizeOpenRouterPrimaryModel(model)
              : undefined,
        fastModel:
          aiMode === 'lab86'
            ? selected.fast
            : provider === 'openrouter'
              ? normalizeOpenRouterFastModel(fastModel)
              : undefined,
        apiKey: aiMode === 'byok' ? apiKey || undefined : undefined,
      });
    },
    onSuccess: () => {
      setApiKey('');
      toast.success('AI settings saved');
      qc.invalidateQueries({ queryKey: ['ai-settings'] });
    },
    onError: (err: any) => toast.error(err?.message || 'Could not save AI settings'),
  });

  const deleteKey = useMutation({
    mutationFn: async () =>
      fetch(`/api/ai/settings?provider=${encodeURIComponent(provider)}`, { method: 'DELETE' }).then(check),
    onSuccess: () => {
      toast.success('API key removed');
      qc.invalidateQueries({ queryKey: ['ai-settings'] });
    },
  });

  const disconnect = useMutation({
    mutationFn: async (accountId: string) => postJson('/api/nylas/disconnect', { accountId }),
    onSuccess: () => {
      toast.success('Account disconnected');
      qc.invalidateQueries({ queryKey: ['nylas-status'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
    },
    onError: (err: any) => toast.error(err?.message || 'Could not disconnect account'),
  });
  const saveAlias = useMutation({
    mutationFn: async ({ accountId, displayName }: { accountId: string; displayName: string }) =>
      patchJson('/api/nylas/account', { accountId, displayName }),
    onSuccess: () => {
      toast.success('Alias saved');
      qc.invalidateQueries({ queryKey: ['nylas-status'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
    },
    onError: (err: any) => toast.error(err?.message || 'Could not save alias'),
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

  const accounts = nylas?.accounts || [];
  const providerCapabilities = (nylas?.capabilities || []).filter((provider: any) => provider.visible);
  const clerkEnabled = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
  const requireOpenRouter = Boolean(ai?.requiresUserOpenRouterKey);
  const subscriptionsDisabled = Boolean(ai?.subscriptionsDisabled);
  const primaryModelDetail = OPENROUTER_PRIMARY_MODEL_OPTIONS.find((option) => option.id === model)?.detail;
  const fastModelDetail = OPENROUTER_FAST_MODEL_OPTIONS.find((option) => option.id === fastModel)?.detail;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[86vh] max-w-2xl overflow-y-auto">
        <DialogTitle>Accounts and AI</DialogTitle>
        <div className="space-y-6">
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-[13px] font-semibold">Connected mail</h3>
                <p className="text-[11.5px] text-[var(--color-text-muted)]">
                  Mail providers use Nylas hosted OAuth.
                </p>
              </div>
              <div className="flex items-center gap-2">
                {providerCapabilities.map((provider: any) => {
                  const Icon = provider.provider === 'google' ? MailPlus : Link2;
                  return (
                    <Button
                      key={provider.provider}
                      size="sm"
                      variant="outline"
                      asChild={provider.connectable}
                      disabled={!provider.connectable}
                    >
                      {provider.connectable ? (
                        <a href={`/api/nylas/connect?provider=${provider.provider}`}>
                          <Icon className="size-3.5" />
                          {provider.label}
                        </a>
                      ) : (
                        <span>{provider.label}</span>
                      )}
                    </Button>
                  );
                })}
              </div>
            </div>
            {providerCapabilities.some((provider: any) => provider.provider === 'icloud') ? (
              <p className="text-[11px] text-[var(--color-text-muted)]">
                iCloud requires an Apple app-specific password before connecting.
              </p>
            ) : null}
            <div className="space-y-2">
              {accounts.length ? (
                accounts.map((account: any) => (
                  <div
                    key={account.accountId}
                    className="grid gap-2 rounded-md border border-[var(--color-border)] px-3 py-2 text-[12.5px] sm:grid-cols-[minmax(0,1fr)_auto]"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium">{account.displayName || account.email}</div>
                      <div className="truncate text-[11px] text-[var(--color-text-muted)]">
                        {account.email} · {account.provider}
                      </div>
                    </div>
                    <form
                      className="flex min-w-0 gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const data = new FormData(event.currentTarget);
                        saveAlias.mutate({
                          accountId: account.accountId,
                          displayName: String(data.get('displayName') || ''),
                        });
                      }}
                    >
                      <Input
                        name="displayName"
                        defaultValue={account.displayName || ''}
                        placeholder="Alias"
                        className="h-8 w-36"
                      />
                      <Button type="submit" size="sm" variant="outline" disabled={saveAlias.isPending}>
                        Save
                      </Button>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => disconnect.mutate(account.accountId)}
                        className="text-[var(--color-text-muted)]"
                        title="Disconnect account"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </form>
                  </div>
                ))
              ) : (
                <div className="rounded-md border border-[var(--color-border)] px-3 py-2 text-[12px] text-[var(--color-text-muted)]">
                  No hosted mail accounts connected.
                </div>
              )}
            </div>
          </section>

          <section className="space-y-3">
            <div>
              <h3 className="text-[13px] font-semibold">AI provider</h3>
              <p className="text-[11.5px] text-[var(--color-text-muted)]">
                {requireOpenRouter
                  ? 'Subscriptions are paused. Add your OpenRouter key to use AI features.'
                  : 'Lab86 AI is included with the paid plan. BYOK uses your provider key.'}
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Mode</Label>
                <Select
                  value={aiMode}
                  onValueChange={(value) => setAiMode(value as 'lab86' | 'byok')}
                  disabled={requireOpenRouter}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {!requireOpenRouter ? <SelectItem value="lab86">Use Lab86 AI</SelectItem> : null}
                    <SelectItem value="byok">Use my API key</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>{aiMode === 'lab86' ? 'Model family' : 'Provider'}</Label>
                <Select
                  value={aiMode === 'lab86' ? lab86Family : provider}
                  onValueChange={(value) =>
                    aiMode === 'lab86'
                      ? setLab86Family(value as Lab86ModelFamily)
                      : setProviderForByok(value as Provider, setProvider, setModel, setFastModel)
                  }
                  disabled={requireOpenRouter}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {aiMode === 'lab86' ? (
                      <>
                        <SelectItem value="openai">OpenAI</SelectItem>
                        <SelectItem value="claude">Claude</SelectItem>
                      </>
                    ) : (
                      <>
                        <SelectItem value="openrouter">OpenRouter</SelectItem>
                        {!requireOpenRouter ? <SelectItem value="openai">OpenAI</SelectItem> : null}
                        {!requireOpenRouter ? <SelectItem value="anthropic">Anthropic</SelectItem> : null}
                      </>
                    )}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Primary model</Label>
                {aiMode === 'lab86' ? (
                  <Input value={LAB86_MODEL_FAMILIES[lab86Family].primary} readOnly />
                ) : provider === 'openrouter' ? (
                  <>
                    <Select value={model} onValueChange={setModel}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {OPENROUTER_PRIMARY_MODEL_OPTIONS.map((option) => (
                          <SelectItem key={option.id} value={option.id}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {primaryModelDetail ? (
                      <p className="text-[11px] text-[var(--color-text-muted)]">{primaryModelDetail}</p>
                    ) : null}
                  </>
                ) : (
                  <Input value="Provider default" readOnly />
                )}
              </div>
              <div className="space-y-1.5">
                <Label>Fast model</Label>
                {aiMode === 'lab86' ? (
                  <Input value={LAB86_MODEL_FAMILIES[lab86Family].fast} readOnly />
                ) : provider === 'openrouter' ? (
                  <>
                    <Select value={fastModel} onValueChange={setFastModel}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {OPENROUTER_FAST_MODEL_OPTIONS.map((option) => (
                          <SelectItem key={option.id} value={option.id}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {fastModelDetail ? (
                      <p className="text-[11px] text-[var(--color-text-muted)]">{fastModelDetail}</p>
                    ) : null}
                  </>
                ) : (
                  <Input value="Provider default" readOnly />
                )}
              </div>
              {aiMode === 'lab86' ? (
                <div className="rounded-md border border-[var(--color-border)] px-3 py-2 text-[12px] text-[var(--color-text-muted)] sm:col-span-2">
                  {LAB86_MODEL_FAMILIES[lab86Family].detail}
                </div>
              ) : null}
              {aiMode === 'byok' ? (
                <div className="space-y-1.5 sm:col-span-2">
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
                    <Button type="button" onClick={() => saveAi.mutate()} disabled={saveAi.isPending}>
                      <KeyRound className="size-3.5" />
                      Save
                    </Button>
                    {ai?.key ? (
                      <Button type="button" variant="outline" onClick={() => deleteKey.mutate()}>
                        <LogOut className="size-3.5" />
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => saveAi.mutate()}
                  disabled={saveAi.isPending}
                  className="sm:col-span-2"
                >
                  <KeyRound className="size-3.5" />
                  Save AI settings
                </Button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--color-border)] px-3 py-2 text-[12px]">
              <span>
                {subscriptionsDisabled
                  ? 'Subscriptions are paused. AI usage requires your OpenRouter key.'
                  : ai?.usage?.status === 'reduced_cost'
                    ? 'AI is using reduced-cost routing for this billing period.'
                    : ai?.usage?.status === 'exhausted'
                      ? 'AI chat is paused for this billing period. Core mail automation continues.'
                      : 'Lab86 Mail Pro is $15/month or $120/year.'}
              </span>
              {!subscriptionsDisabled ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => checkout.mutate()}
                    disabled={checkout.isPending}
                    className="ml-auto"
                  >
                    <CreditCard className="size-3.5" />
                    Upgrade
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => portal.mutate()}
                    disabled={portal.isPending}
                  >
                    Manage
                  </Button>
                </>
              ) : null}
            </div>
          </section>

          {clerkEnabled ? (
            <section className="flex items-center justify-between gap-3 border-t border-[var(--color-border)] pt-4">
              <span className="text-[12px] text-[var(--color-text-muted)]">Signed in with Clerk</span>
              <UserButton />
            </section>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
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

async function patchJson(url: string, body: any) {
  return check(
    await fetch(url, {
      method: 'PATCH',
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
