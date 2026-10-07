'use client';

// Settings, Saved sign-ins: the shared browser keeps the sites the user signed
// in to, so the step runner finds them signed in next time. The row says
// whether a saved context exists and offers to forget it. The server contract
// is GET and DELETE /api/albatross/browser-context.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { SettingsCard, SettingsGroupTitle, SettingsRow } from './primitives';

const QUERY_KEY = ['albatross-browser-context'];

export interface BrowserContextState {
  saved: boolean;
  createdAt?: number;
  lastUsedAt?: number;
}

export const SAVED_SIGN_INS_COPY = {
  title: 'Saved sign-ins',
  description:
    'When you sign in to a site in the shared browser, the browser keeps that sign-in for the next run. Albatross never sees a password.',
  none: 'No saved sign-ins.',
  forget: 'Forget saved sign-ins',
  forgetting: 'Forgetting…',
  loading: 'Checking…',
  error: 'Could not check the saved sign-ins.',
} as const;

export function savedSignInsHint(state: BrowserContextState | null, now = Date.now()): string {
  if (!state?.saved) return SAVED_SIGN_INS_COPY.none;
  const at = state.lastUsedAt ?? state.createdAt;
  if (!at) return 'Saved.';
  const days = Math.floor((now - at) / 86_400_000);
  if (days <= 0) return 'Saved. Last used today.';
  if (days === 1) return 'Saved. Last used yesterday.';
  return `Saved. Last used ${days} days ago.`;
}

async function readJson(res: Response) {
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.ok === false) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

/** The row itself, with its state in props, so the harness renders it without a server. */
export function SavedSignInsRow({
  state,
  busy,
  loading,
  error,
  onForget,
}: {
  state: BrowserContextState | null;
  busy?: boolean;
  loading?: boolean;
  error?: string | null;
  onForget: () => void;
}) {
  return (
    <>
      <SettingsGroupTitle>In the shared browser</SettingsGroupTitle>
      <SettingsCard>
        <SettingsRow
          label={SAVED_SIGN_INS_COPY.title}
          description={SAVED_SIGN_INS_COPY.description}
          hint={
            <span data-slot="saved-sign-ins-state">
              {loading ? SAVED_SIGN_INS_COPY.loading : error ? error : savedSignInsHint(state)}
            </span>
          }
          control={
            state?.saved ? (
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onForget}>
                {busy ? SAVED_SIGN_INS_COPY.forgetting : SAVED_SIGN_INS_COPY.forget}
              </Button>
            ) : null
          }
        />
      </SettingsCard>
    </>
  );
}

export function SavedSignIns() {
  const qc = useQueryClient();
  const query = useQuery<BrowserContextState>({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const res = await fetch('/api/albatross/browser-context', { cache: 'no-store' });
      // The route lands with the step runner; before that, nothing is saved.
      if (res.status === 404) return { saved: false };
      const data = await readJson(res);
      return { saved: Boolean(data?.saved), createdAt: data?.createdAt, lastUsedAt: data?.lastUsedAt };
    },
  });
  const forget = useMutation({
    mutationFn: async () => readJson(await fetch('/api/albatross/browser-context', { method: 'DELETE' })),
    onSuccess: () => {
      qc.setQueryData<BrowserContextState>(QUERY_KEY, { saved: false });
      toast.success('Saved sign-ins forgotten');
    },
    onError: (err: any) => toast.error(err?.message || 'Could not forget the saved sign-ins'),
  });
  return (
    <SavedSignInsRow
      state={query.data ?? null}
      loading={query.isLoading}
      error={query.isError ? SAVED_SIGN_INS_COPY.error : null}
      busy={forget.isPending}
      onForget={() => forget.mutate()}
    />
  );
}
