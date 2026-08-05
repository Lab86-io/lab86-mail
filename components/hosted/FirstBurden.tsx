'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { AlbatrossMark } from '@/components/albatross/AlbatrossMark';
import { ProviderLogo, providerDisplayName } from '@/components/icons/provider-logos';
import { Ring } from '@/components/loading-ui/ring';
import { Button } from '@/components/ui/button';
import { ONBOARDING_DISMISSED_STORAGE_KEY } from './onboarding-state';

interface NylasAccount {
  accountId: string;
  email: string;
  provider: 'google' | 'microsoft' | 'icloud' | 'imap';
}

interface NylasCapability {
  provider: NylasAccount['provider'];
  label: string;
  visible: boolean;
  connectable: boolean;
  reason?: string;
}

async function fetchJson(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

/**
 * First run, inverted.
 *
 * It used to ask for a mailbox, then a model provider, then a normal model and
 * a fast model with per-token prices — all before the product knew a single
 * thing about the person. That order makes the north star's own rule
 * impossible: you cannot ask for only the context an outcome needs if you do
 * not yet know the outcome.
 *
 * So: name one thing you keep meaning to handle. Everything else follows from
 * it, and every request afterwards can say what it is for.
 */
export function FirstBurden() {
  const router = useRouter();
  const [text, setText] = useState('');
  const [stage, setStage] = useState<'ask' | 'saving' | 'connect'>('ask');
  const [error, setError] = useState<string | null>(null);
  const [workId, setWorkId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { data: nylas } = useQuery({
    queryKey: ['nylas-status'],
    queryFn: async () =>
      fetchJson('/api/nylas/status') as Promise<{
        accounts?: NylasAccount[];
        capabilities?: NylasCapability[];
      }>,
    retry: false,
    refetchInterval: stage === 'connect' ? 4000 : false,
  });
  const accounts = nylas?.accounts || [];
  const capabilities = (nylas?.capabilities || []).filter((item) => item.visible);

  useEffect(() => {
    if (stage === 'ask') textareaRef.current?.focus();
  }, [stage]);

  const finish = () => {
    try {
      window.localStorage.setItem(ONBOARDING_DISMISSED_STORAGE_KEY, '1');
    } catch {}
    router.replace(workId ? `/?view=albatrosses&work=${encodeURIComponent(workId)}` : '/?view=today');
  };

  const save = async () => {
    const raw = text.trim();
    if (!raw || stage === 'saving') return;
    setStage('saving');
    setError(null);
    try {
      const response = await fetch('/api/albatross/capture', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          rawText: raw,
          source: 'text',
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not save that.');
      const ids = Array.isArray(body.workIds) ? body.workIds.map(String) : [];
      setWorkId(ids[0] || null);
      // Albatross starts working on it immediately; the connection request
      // below is an offer, not a gate.
      for (const id of ids) {
        void fetch(`/api/albatross/work/${encodeURIComponent(id)}/advance`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
        });
      }
      setStage('connect');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save that.');
      setStage('ask');
    }
  };

  if (stage === 'connect') {
    return (
      <div className="w-full max-w-xl">
        <AlbatrossMark className="mx-auto size-12 text-[var(--color-accent)]" />
        <h1 className="mt-5 text-center font-serif text-[26px] font-semibold leading-tight tracking-tight">
          Albatross has it.
        </h1>
        <p className="mx-auto mt-3 max-w-md text-center text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
          It is working out what you want and what it already knows. One thing would help it more than
          anything else:
        </p>

        <div className="mt-6 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-5">
          <h2 className="text-[14px] font-semibold">Connect a mailbox</h2>
          <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
            Most of what you are carrying arrives by email — the request, the receipt, the confirmation, the
            reply you are waiting on. With a mailbox connected, Albatross can find the context for this
            without asking you to repeat it, and it can tell when the thing is actually done.
          </p>

          {accounts.length ? (
            <p className="mt-4 rounded-xl border border-[var(--color-success)]/30 bg-[var(--color-success-soft)] px-3 py-2 text-[12.5px] text-[var(--color-text)]">
              {accounts[0].email} is connected.
            </p>
          ) : (
            <div className="mt-4 flex flex-wrap gap-2">
              {capabilities.map((capability) => (
                <Button
                  key={capability.provider}
                  asChild={capability.connectable}
                  size="sm"
                  variant="outline"
                  disabled={!capability.connectable}
                  title={capability.reason}
                >
                  {capability.connectable ? (
                    <a href={`/api/nylas/connect?provider=${capability.provider}&redirectTo=/welcome`}>
                      <ProviderLogo provider={capability.provider} className="size-4" />
                      {providerDisplayName(capability.provider)}
                    </a>
                  ) : (
                    <span>
                      <ProviderLogo provider={capability.provider} className="size-4" />
                      {providerDisplayName(capability.provider)}
                    </span>
                  )}
                </Button>
              ))}
            </div>
          )}
        </div>

        <div className="mt-6 flex items-center justify-center gap-3">
          <Button type="button" onClick={finish}>
            {accounts.length ? 'See what Albatross found' : 'Skip for now'}
          </Button>
        </div>
        <p className="mt-3 text-center text-[11.5px] text-[var(--color-text-faint)]">
          You can connect a mailbox later, and Albatross keeps working either way.
        </p>
      </div>
    );
  }

  return (
    <div className="w-full max-w-xl">
      <AlbatrossMark className="mx-auto size-12 text-[var(--color-accent)]" />
      <h1 className="mt-5 text-center font-serif text-[clamp(24px,5vw,32px)] font-semibold leading-tight tracking-tight">
        What is one thing you keep meaning to handle?
      </h1>
      <p className="mx-auto mt-3 max-w-md text-center text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
        Write it however it comes to mind. You do not need to organize it first, and it does not have to be
        small.
      </p>

      <textarea
        ref={textareaRef}
        value={text}
        disabled={stage === 'saving'}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            void save();
          }
        }}
        placeholder="I think my passport is expired and I am travelling next month…"
        aria-label="The thing you keep meaning to handle"
        className="mt-7 min-h-32 w-full resize-none rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-3.5 text-center text-[15px] leading-relaxed outline-none placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)]"
      />

      {error ? <p className="mt-2 text-center text-[12px] text-[var(--color-danger)]">{error}</p> : null}

      <div className="mt-5 flex items-center justify-center gap-3">
        <Button type="button" disabled={!text.trim() || stage === 'saving'} onClick={() => void save()}>
          {stage === 'saving' ? <Ring className="size-3" /> : null}
          {stage === 'saving' ? 'Taking it…' : 'Hand it over'}
        </Button>
        <button
          type="button"
          onClick={finish}
          className="text-[12.5px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          I will do this later
        </button>
      </div>
    </div>
  );
}
