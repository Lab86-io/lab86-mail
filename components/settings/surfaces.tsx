'use client';

// Optional surfaces from Settings, Advanced. The server owns the choice
// (GET/POST /api/account/surfaces) so web and native agree; the client store
// keeps a copy so the rail draws the right rows before the answer arrives.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { useClientStore } from '@/lib/client-state';

const SURFACES_KEY = ['account-surfaces'];

async function readJson(res: Response) {
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.ok === false) throw new Error(data?.error || `Request failed (${res.status})`);
  return data as { ok: true; surfaces: { files: boolean } };
}

/** Whether Files shows in the rail, kept in step with the server. */
export function useFilesSurface(): boolean {
  const enabled = useClientStore((s) => s.filesSurfaceEnabled);
  const setEnabled = useClientStore((s) => s.setFilesSurfaceEnabled);
  const { data } = useQuery({
    queryKey: SURFACES_KEY,
    queryFn: async () =>
      (await readJson(await fetch('/api/account/surfaces', { cache: 'no-store' }))).surfaces,
    staleTime: 5 * 60_000,
    retry: false,
  });
  useEffect(() => {
    if (typeof data?.files === 'boolean' && data.files !== enabled) setEnabled(data.files);
  }, [data?.files, enabled, setEnabled]);
  return enabled;
}

/** The Settings switch: the rail changes only after the server stores the choice. */
export function useSetFilesSurface() {
  const qc = useQueryClient();
  const setEnabled = useClientStore((s) => s.setFilesSurfaceEnabled);
  return useMutation({
    mutationFn: async (files: boolean) =>
      (
        await readJson(
          await fetch('/api/account/surfaces', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ files }),
          }),
        )
      ).surfaces,
    onSuccess: (surfaces) => {
      setEnabled(surfaces.files);
      qc.setQueryData(SURFACES_KEY, surfaces);
    },
    onError: (err: any) => toast.error(err?.message || 'Could not change Files'),
  });
}
