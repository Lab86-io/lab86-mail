'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
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

const STORAGE_KEY = 'lab86-mail-onboarding-dismissed-v1';

export function HostedOnboarding() {
  const qc = useQueryClient();
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [aiMode, setAiMode] = useState<'lab86' | 'byok'>('byok');
  const [lab86Family, setLab86Family] = useState<Lab86ModelFamily>('openai');
  const [provider, setProvider] = useState<Provider>('openrouter');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [fastModel, setFastModel] = useState('');

  const { data: nylas, isLoading: loadingAccounts } = useQuery({
    queryKey: ['nylas-status'],
    queryFn: async () => fetchJson('/api/nylas/status'),
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
      const nextProvider = requireOpenRouter
        ? 'openrouter'
        : data.settings?.provider || data.key?.provider || 'openrouter';
      setAiMode(requireOpenRouter ? 'byok' : data.settings?.mode || 'lab86');
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
      setLab86Family(resolveLab86Family(data.settings?.model, data.settings?.fastModel));
      return data;
    },
    retry: false,
  });

  const accounts = nylas?.accounts || [];
  const providerCapabilities = (nylas?.capabilities || []).filter((provider: any) => provider.visible);
  const hasAccounts = accounts.length > 0;

  useEffect(() => {
    setDismissed(window.localStorage.getItem(STORAGE_KEY) === '1');
  }, []);

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

  useEffect(() => {
    if (dismissed === null || loadingAccounts) return;
    if (!hasAccounts || !dismissed) setOpen(true);
  }, [dismissed, hasAccounts, loadingAccounts]);

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
      toast.success('AI preference saved');
      qc.invalidateQueries({ queryKey: ['ai-settings'] });
    },
    onError: (err: any) => toast.error(err?.message || 'Could not save AI preference'),
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

  const complete = () => {
    if (!hasAccounts) return;
    window.localStorage.setItem(STORAGE_KEY, '1');
    setDismissed(true);
    setOpen(false);
  };

  const close = (nextOpen: boolean) => {
    if (nextOpen) {
      setOpen(true);
      return;
    }
    if (hasAccounts) complete();
  };

  const selected = LAB86_MODEL_FAMILIES[lab86Family];
  const requireOpenRouter = Boolean(ai?.requiresUserOpenRouterKey);
  const primaryModelDetail = OPENROUTER_PRIMARY_MODEL_OPTIONS.find((option) => option.id === model)?.detail;
  const fastModelDetail = OPENROUTER_FAST_MODEL_OPTIONS.find((option) => option.id === fastModel)?.detail;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[88vh] max-w-3xl overflow-y-auto p-0">
        <div className="border-b border-[var(--color-border)] px-5 py-4">
          <DialogTitle>Set up Lab86 Mail</DialogTitle>
          <p className="mt-1 text-[12px] text-[var(--color-text-muted)]">
            Connect mail first, then choose how AI runs.
          </p>
        </div>

        <div className="grid gap-0 md:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
          <section className="space-y-4 border-b border-[var(--color-border)] px-5 py-5 md:border-b-0 md:border-r">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <Badge variant={hasAccounts ? 'default' : 'outline'}>1</Badge>
                  <h3 className="text-[13px] font-semibold">Add email accounts</h3>
                </div>
                <p className="mt-1 text-[11.5px] text-[var(--color-text-muted)]">
                  Mail accounts connect through Nylas hosted OAuth.
                </p>
              </div>
              {hasAccounts ? (
                <span className="size-2.5 rounded-full bg-emerald-500" title="Accounts connected" />
              ) : null}
            </div>

            <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-1">
              {providerCapabilities.map((provider: any, index: number) => (
                <Button
                  key={provider.provider}
                  asChild={provider.connectable}
                  className="justify-start"
                  disabled={!provider.connectable}
                  variant={index === 0 ? 'default' : 'outline'}
                >
                  {provider.connectable ? (
                    <a href={`/api/nylas/connect?provider=${provider.provider}&redirectTo=/`}>
                      Connect {provider.label}
                    </a>
                  ) : (
                    <span>{provider.reason || `${provider.label} unavailable`}</span>
                  )}
                </Button>
              ))}
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
                    key={account.accountId || account.email}
                    className="space-y-2 rounded-md border border-[var(--color-border)] px-3 py-2 text-[12px]"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="size-2 rounded-full bg-emerald-500" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{account.displayName || account.email}</div>
                        <div className="truncate text-[11px] text-[var(--color-text-muted)]">
                          {account.email} · {account.provider}
                        </div>
                      </div>
                    </div>
                    <form
                      className="flex gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const data = new FormData(event.currentTarget);
                        saveAlias.mutate({
                          accountId: account.accountId,
                          displayName: String(data.get('displayName') || '').trim(),
                        });
                      }}
                    >
                      <Input
                        name="displayName"
                        defaultValue={account.displayName || ''}
                        placeholder="Alias"
                        className="h-8"
                      />
                      <Button type="submit" size="sm" variant="outline" disabled={saveAlias.isPending}>
                        Save
                      </Button>
                    </form>
                  </div>
                ))
              ) : (
                <div className="rounded-md border border-dashed border-[var(--color-border)] px-3 py-3 text-[12px] text-[var(--color-text-muted)]">
                  No accounts connected yet.
                </div>
              )}
            </div>
          </section>

          <section className="space-y-4 px-5 py-5">
            <div>
              <div className="flex items-center gap-2">
                <Badge variant="outline">2</Badge>
                <h3 className="text-[13px] font-semibold">Choose AI mode</h3>
              </div>
              <p className="mt-1 text-[11.5px] text-[var(--color-text-muted)]">
                Use the Lab86 paid plan path or bring your own provider key.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setAiMode('lab86')}
                disabled={requireOpenRouter}
                className={cn(
                  'rounded-md border p-3 text-left transition-colors',
                  aiMode === 'lab86'
                    ? 'border-[var(--color-accent)] bg-[var(--color-bg-subtle)]'
                    : 'border-[var(--color-border)] hover:bg-[var(--color-bg-subtle)]',
                  requireOpenRouter && 'cursor-not-allowed opacity-50',
                )}
              >
                <div className="flex items-center gap-2 text-[13px] font-semibold">Lab86 AI</div>
                <p className="mt-1 text-[11.5px] text-[var(--color-text-muted)]">
                  Use our hosted OpenRouter key and included dev credits.
                </p>
              </button>

              <button
                type="button"
                onClick={() => setAiMode('byok')}
                className={cn(
                  'rounded-md border p-3 text-left transition-colors',
                  aiMode === 'byok'
                    ? 'border-[var(--color-accent)] bg-[var(--color-bg-subtle)]'
                    : 'border-[var(--color-border)] hover:bg-[var(--color-bg-subtle)]',
                )}
              >
                <div className="flex items-center gap-2 text-[13px] font-semibold">BYOK</div>
                <p className="mt-1 text-[11.5px] text-[var(--color-text-muted)]">
                  Save a provider key for developer-controlled usage.
                </p>
              </button>
            </div>

            {aiMode === 'lab86' ? (
              <div className="space-y-2">
                <Label>Model family</Label>
                <Select
                  value={lab86Family}
                  onValueChange={(value) => setLab86Family(value as Lab86ModelFamily)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai">OpenAI</SelectItem>
                    <SelectItem value="claude">Claude</SelectItem>
                  </SelectContent>
                </Select>
                <div className="rounded-md border border-[var(--color-border)] px-3 py-2 text-[12px] text-[var(--color-text-muted)]">
                  {selected.detail}
                </div>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
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
                <div className="space-y-1.5">
                  <Label>Primary model</Label>
                  {provider === 'openrouter' ? (
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
                  {provider === 'openrouter' ? (
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
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-border)] pt-4">
              <p className="text-[11.5px] text-[var(--color-text-muted)]">
                {ai?.usage
                  ? `${ai.usage.remaining.toLocaleString()} credits available`
                  : 'Credits appear after AI settings load.'}
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => saveAi.mutate()}
                  disabled={saveAi.isPending}
                >
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
                  disabled={!hasAccounts || saveAi.isPending}
                >
                  Continue
                </Button>
              </div>
            </div>
          </section>
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
