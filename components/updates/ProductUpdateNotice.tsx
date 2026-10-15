'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpCircle, Loader2 } from 'lucide-react';
import { useState } from 'react';
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
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import {
  CURRENT_PRODUCT_RELEASE,
  fetchProductRelease,
  newReleaseUpdates,
  type ProductRelease,
} from '@/lib/updates/release';
import { UpdateFeed } from './UpdateFeed';

export function ProductUpdateNotice() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reviewed, setReviewed] = useState<ProductRelease | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['product-release'],
    queryFn: ({ signal }) => fetchProductRelease(signal),
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: false,
  });
  const available = query.data && query.data.id !== CURRENT_PRODUCT_RELEASE.id ? query.data : null;

  async function applyUpdate() {
    if (!reviewed || checking) return;
    setChecking(true);
    setError(null);
    try {
      const latest = await fetchProductRelease();
      queryClient.setQueryData(['product-release'], latest);
      if (latest.id === CURRENT_PRODUCT_RELEASE.id) {
        setOpen(false);
        return;
      }
      if (latest.id !== reviewed.id) {
        setReviewed(latest);
        setError('Another update is ready. Review its changes, then choose Reload to update.');
        return;
      }
      // Preserve native beforeunload guards and the current URL, including any open work.
      window.location.reload();
    } catch {
      setError('Couldn’t reach the update. Check your connection and try again.');
    } finally {
      setChecking(false);
    }
  }

  if (!available && !open) return null;
  const changes = reviewed ? newReleaseUpdates(reviewed, CURRENT_PRODUCT_RELEASE) : [];
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {available ? (
        <SidebarMenuItem>
          <DialogTrigger asChild>
            <SidebarMenuButton
              tooltip="Update available"
              aria-haspopup="dialog"
              className="text-[var(--color-accent)]"
              onClick={() => {
                setReviewed(available);
                setError(null);
                setOpen(true);
              }}
            >
              <ArrowUpCircle className="size-4 shrink-0" aria-hidden />
              <span>Update available</span>
            </SidebarMenuButton>
          </DialogTrigger>
        </SidebarMenuItem>
      ) : null}
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>An update is ready</DialogTitle>
          <DialogDescription>See what changed, then reload when you’re ready.</DialogDescription>
        </DialogHeader>
        {changes.length ? (
          <UpdateFeed updates={changes} />
        ) : (
          <p className="text-[13px] text-[var(--color-text-muted)]">
            This version includes maintenance updates. There are no new feature notes.
          </p>
        )}
        {error ? (
          <p role="alert" className="text-[12.5px] text-[var(--color-danger)]">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={checking} onClick={() => setOpen(false)}>
            Later
          </Button>
          <Button disabled={checking} onClick={applyUpdate}>
            {checking ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
            Reload to update
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
