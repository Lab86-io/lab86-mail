'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  prepareReleaseArrival,
  receiptForRelease,
  releaseHistoryStores,
  writeReleaseHistory,
} from '@/lib/updates/receipt';
import {
  CURRENT_PRODUCT_RELEASE,
  fetchProductRelease,
  newReleaseUpdates,
  type ProductRelease,
} from '@/lib/updates/release';
import { UpdateFeed } from './UpdateFeed';

/** The update flow follows the app across pages, independently of its sidebar. */
export function ProductUpdateNotice() {
  const pathname = usePathname();
  const appPage = ['/', '/settings', '/updates', '/narrative', '/brief'].includes(pathname);
  // Sign-in, public pages, native handoffs and embedded previews have their own flows.
  return appPage ? <ProductUpdateFlow /> : null;
}

function ProductUpdateFlow() {
  const queryClient = useQueryClient();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [open, setOpen] = useState(false);
  const [reviewed, setReviewed] = useState<ProductRelease | null>(null);
  const [installedAfter, setInstalledAfter] = useState<readonly string[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['product-release'],
    queryFn: ({ signal }) => fetchProductRelease(signal),
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
    retry: false,
  });
  const available = query.data && query.data.id !== CURRENT_PRODUCT_RELEASE.id ? query.data : null;

  useEffect(() => {
    const previous = prepareReleaseArrival(CURRENT_PRODUCT_RELEASE, releaseHistoryStores());
    if (previous) {
      setInstalledAfter(previous.entryIds);
      setOpen(true);
    }
  }, []);

  function close() {
    if (installedAfter !== null) {
      writeReleaseHistory(releaseHistoryStores(), receiptForRelease(CURRENT_PRODUCT_RELEASE));
      setInstalledAfter(null);
    }
    setOpen(false);
    setReviewed(null);
    setError(null);
  }

  async function applyUpdate() {
    if (!reviewed || checking) return;
    setChecking(true);
    setError(null);
    try {
      const latest = await fetchProductRelease();
      queryClient.setQueryData(['product-release'], latest);
      if (latest.id === CURRENT_PRODUCT_RELEASE.id) {
        close();
        return;
      }
      if (latest.id !== reviewed.id) {
        setReviewed(latest);
        setError('Another update is ready. Review its changes, then choose Update now.');
        return;
      }
      // Native unsaved-work guards still run; the current URL stays intact.
      window.location.reload();
    } catch {
      setError('Couldn’t reach the update. Check your connection and try again.');
    } finally {
      setChecking(false);
    }
  }

  const installed = installedAfter !== null;
  const displayed = installed ? CURRENT_PRODUCT_RELEASE : reviewed;
  const knownIds = installedAfter ?? CURRENT_PRODUCT_RELEASE.updates.map((update) => update.id);
  const changes = displayed ? newReleaseUpdates(displayed, knownIds) : [];
  if (!available && !open) return null;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      {available
        ? createPortal(
            <aside
              aria-label="Application update"
              data-slot="product-update-notice"
              className="corner-smooth fixed bottom-[max(16px,env(safe-area-inset-bottom))] left-[max(16px,env(safe-area-inset-left))] z-40 flex max-w-[calc(100vw-32px)] flex-wrap items-center gap-3 rounded-overlay border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-3 text-[var(--color-text)] shadow-[var(--shadow-pop)]"
            >
              <span role="status" className="text-[13px] font-medium">
                A new version is ready
              </span>
              <DialogTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  aria-haspopup="dialog"
                  onClick={() => {
                    setReviewed(available);
                    setError(null);
                    setOpen(true);
                  }}
                >
                  Update available
                </Button>
              </DialogTrigger>
            </aside>,
            document.body,
          )
        : null}
      <DialogContent
        className="max-h-[85dvh] overflow-y-auto sm:max-w-xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          titleRef.current?.focus({ preventScroll: true });
        }}
      >
        <DialogHeader>
          <DialogTitle ref={titleRef} tabIndex={-1} className="outline-none">
            What’s new in Albatross
          </DialogTitle>
          <DialogDescription>
            {installed
              ? 'You’re using the latest version. Here’s what changed since your last version.'
              : 'Review the changes, then update when you’re ready.'}
          </DialogDescription>
        </DialogHeader>
        {changes.length ? (
          <UpdateFeed updates={changes} />
        ) : (
          <p className="text-[13px] text-[var(--color-text-muted)]">
            This version includes maintenance updates. There are no new feature notes.
          </p>
        )}
        {!installed ? (
          <p className="text-[12.5px] text-[var(--color-text-muted)]">
            Save your work first. Updating reloads this page; unsaved changes may be lost.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-[12.5px] text-[var(--color-danger)]">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          {installed ? (
            <Button onClick={close}>Got it</Button>
          ) : (
            <>
              <Button variant="outline" disabled={checking} onClick={close}>
                Later
              </Button>
              <Button disabled={checking} aria-busy={checking} onClick={applyUpdate}>
                {checking ? 'Checking update…' : 'Update now'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
