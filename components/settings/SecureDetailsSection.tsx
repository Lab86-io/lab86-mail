'use client';

// Settings, Passwords and IDs: the data layer around SecureDetailsList. It
// reads the list, loads each opened row's uses, and runs the writes. Adding a
// site goes through Clerk's reverification (docs/albatross-secure-store.md,
// lead decision 5): the server answers 403 with Clerk's body, the hook opens
// its modal and retries, and a closed modal leaves one quiet line. The
// "Signed-in sites" row of the shared browser renders as the last group.

import { useReverification } from '@clerk/nextjs';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { usePersonalDetails } from '@/components/ai-elements/use-personal-details';
import {
  createSecureItem,
  deleteSecureItem,
  fetchSecureDetails,
  fetchSecureUses,
  isIdentityCheckCancelled,
  SECURE_DETAILS_QUERY_KEY,
  SecureApiError,
  updateSecureItem,
  useSecureDetails,
} from '@/components/ai-elements/use-secure-details';
import { SECURE_COPY } from '@/lib/albatross/secure-view';
import type { SecureDetailsResponse, SecureItemKind, SecureItemView } from '@/lib/secure/contract';
import { SECURE_FIELD_LABELS } from '@/lib/secure/contract';
import { SavedSignIns } from './SavedSignIns';
import {
  SecureDetailsList,
  type SecureDetailsListProps,
  type SecureItemAction,
  type SecureItemNote,
  type SecureUsesState,
} from './SecureDetailsList';
import { SecureItemSheet, type SecureSheetRequest } from './SecureItemSheet';

export function SecureDetailsSection() {
  const qc = useQueryClient();
  const query = useSecureDetails();
  const personal = usePersonalDetails();
  const [openId, setOpenId] = useState<string | null>(null);
  const [uses, setUses] = useState<Record<string, SecureUsesState | undefined>>({});
  const [busy, setBusy] = useState<{ id: string; action: SecureItemAction } | null>(null);
  const [notes, setNotes] = useState<Record<string, SecureItemNote | undefined>>({});
  const [sheet, setSheet] = useState<SecureSheetRequest | null>(null);
  const addSiteWithCheck = useReverification(updateSecureItem);

  const items = query.data?.items ?? [];
  const nameOnId = personal.data?.details.find((detail) => detail.key === 'name')?.display ?? null;

  const setItems = useCallback(
    (update: (current: SecureItemView[]) => SecureItemView[]) => {
      qc.setQueryData<SecureDetailsResponse>(SECURE_DETAILS_QUERY_KEY, (current) =>
        current ? { ...current, items: update(current.items) } : current,
      );
    },
    [qc],
  );
  const refresh = useCallback(async () => {
    const next = await fetchSecureDetails().catch(() => null);
    if (next) qc.setQueryData(SECURE_DETAILS_QUERY_KEY, next);
    else void qc.invalidateQueries({ queryKey: SECURE_DETAILS_QUERY_KEY });
  }, [qc]);
  const note = (id: string, value: SecureItemNote | undefined) =>
    setNotes((current) => ({ ...current, [id]: value }));

  const loadUses = useCallback((id: string) => {
    setUses((current) => ({ ...current, [id]: { status: 'loading' } }));
    fetchSecureUses(id)
      .then((rows) => setUses((current) => ({ ...current, [id]: { status: 'ready', uses: rows } })))
      .catch(() => setUses((current) => ({ ...current, [id]: { status: 'error' } })));
  }, []);

  const run = async (
    item: SecureItemView,
    action: SecureItemAction,
    work: () => Promise<boolean>,
    fallback: string,
  ): Promise<boolean> => {
    setBusy({ id: item.id, action });
    note(item.id, undefined);
    try {
      return await work();
    } catch (cause) {
      note(item.id, {
        text: cause instanceof Error && cause.message ? cause.message : fallback,
        tone: 'danger',
      });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const handlers: Pick<
    SecureDetailsListProps,
    'onReplace' | 'onRename' | 'onRemoveSite' | 'onAddSite' | 'onDelete' | 'onAdd' | 'onToggle'
  > = {
    onToggle: (id) => {
      setOpenId(id);
      if (id && !uses[id]) loadUses(id);
    },
    onReplace: (item, field, value) =>
      run(
        item,
        'replace',
        async () => {
          const result = await updateSecureItem(item.id, { values: { [field]: value } });
          if (!('item' in result)) return false;
          setItems((current) => current.map((row) => (row.id === item.id ? result.item : row)));
          toast.success(SECURE_COPY.replaced(SECURE_FIELD_LABELS[field] ?? field));
          return true;
        },
        SECURE_COPY.couldNotSave,
      ),
    onRename: (item, label) =>
      run(
        item,
        'rename',
        async () => {
          const result = await updateSecureItem(item.id, { label });
          if (!('item' in result)) return false;
          setItems((current) => current.map((row) => (row.id === item.id ? result.item : row)));
          toast.success(SECURE_COPY.renamed);
          return true;
        },
        SECURE_COPY.couldNotSave,
      ),
    onRemoveSite: (item, site) => {
      void run(
        item,
        'remove_site',
        async () => {
          const result = await updateSecureItem(item.id, { sites: item.sites.filter((own) => own !== site) });
          if (!('item' in result)) return false;
          setItems((current) => current.map((row) => (row.id === item.id ? result.item : row)));
          toast.success(SECURE_COPY.siteRemoved(site));
          return true;
        },
        SECURE_COPY.couldNotSave,
      );
    },
    onAddSite: async (item, raw) => {
      setBusy({ id: item.id, action: 'add_site' });
      note(item.id, undefined);
      try {
        const result = await addSiteWithCheck(item.id, { sites: [...item.sites, raw] });
        if (!result || !('item' in result)) return false;
        const added = result.item.sites.find((site) => !item.sites.includes(site)) ?? raw;
        setItems((current) => current.map((row) => (row.id === item.id ? result.item : row)));
        toast.success(SECURE_COPY.siteAdded(added));
        return true;
      } catch (cause) {
        if (isIdentityCheckCancelled(cause))
          note(item.id, { text: SECURE_COPY.siteCheckCancelled, tone: 'quiet' });
        else if (cause instanceof SecureApiError) note(item.id, { text: cause.message, tone: 'danger' });
        else note(item.id, { text: SECURE_COPY.checkFailed, tone: 'danger' });
        return false;
      } finally {
        setBusy(null);
      }
    },
    onDelete: (item) => {
      void run(
        item,
        'delete',
        async () => {
          await deleteSecureItem(item.id);
          setItems((current) => current.filter((row) => row.id !== item.id));
          setOpenId((current) => (current === item.id ? null : current));
          toast.success(SECURE_COPY.itemDeleted(item.label));
          return true;
        },
        SECURE_COPY.couldNotDelete,
      );
    },
    onAdd: (kind: SecureItemKind) => setSheet({ kind }),
  };

  if (query.data && !query.data.enabled) return null;

  return (
    <>
      <SecureDetailsList
        items={items}
        loading={query.isLoading}
        loadError={query.isError ? SECURE_COPY.loadError : null}
        openId={openId}
        uses={uses}
        busy={busy}
        notes={notes}
        {...handlers}
        browser={<SavedSignIns />}
      />
      <SecureItemSheet
        request={sheet}
        onClose={() => setSheet(null)}
        onSave={createSecureItem}
        onSaved={(item) => {
          setItems((current) => [...current.filter((row) => row.id !== item.id), item]);
          toast.success(SECURE_COPY.itemSaved(item.label));
          void refresh();
        }}
        defaultNameOnId={nameOnId}
        hasDateOfBirth={items.some((item) => item.kind === 'date_of_birth')}
      />
    </>
  );
}
