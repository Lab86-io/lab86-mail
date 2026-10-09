'use client';

// The top of the Documents page: each document that waits for the user, next
// to the Albatross that made it (docs/albatross-blank-design.md). The button
// opens that Albatross in document mode, where the chat can fill the blanks
// and "Done, continue" gives the errand back.

import { useEffect, useState } from 'react';
import { BlankSentence } from '@/components/albatross/BlankSentence';
import { Button } from '@/components/ui/button';
import {
  type DocumentWaitingRow,
  documentsWaitingRows,
  documentTargetOf,
  type StepRunHandoffItem,
} from '@/lib/albatross/step-run-client';
import { openWorkPage } from '@/lib/albatross/step-run-navigation';
import { useClientStore } from '@/lib/client-state';

export const DOCUMENTS_WAITING_COPY = {
  heading: 'Waiting for you',
  madeFor: (workTitle: string) => `Made for: ${workTitle}`,
  open: 'Open',
  openAlbatross: 'Open the Albatross',
} as const;

/** Opens the Albatross on its document, in document mode. */
export function openWaitingDocument(row: DocumentWaitingRow) {
  const state = useClientStore.getState();
  const next = row.row.action?.behaviour;
  const target =
    next && next.kind === 'open_document' ? documentTargetOf(next.url ?? null, next.id ?? null) : null;
  if (target) state.setPendingThreadDocument({ workId: row.workId, target });
  openWorkPage({ getState: () => state }, row.workId);
}

export function DocumentsWaitingList({
  rows,
  onOpen,
  onOpenWork,
}: {
  rows: readonly DocumentWaitingRow[];
  onOpen: (row: DocumentWaitingRow) => void;
  onOpenWork: (workId: string) => void;
}) {
  if (!rows.length) return null;
  return (
    <section
      aria-label={DOCUMENTS_WAITING_COPY.heading}
      data-documents-waiting=""
      className="border-b border-[var(--color-border)] px-4 pb-6 pt-5"
    >
      <h2 className="mb-3 text-[13px] font-semibold text-[var(--color-text-muted)]">
        {DOCUMENTS_WAITING_COPY.heading}
      </h2>
      <ul className="flex flex-col gap-6">
        {rows.map((row) => (
          <li key={row.runId} data-documents-waiting-row={row.runId} className="max-w-[720px]">
            <p className="truncate text-[12.5px] text-[var(--color-text-muted)]">
              {DOCUMENTS_WAITING_COPY.madeFor(row.workTitle)}
            </p>
            <p className="mt-0.5 text-[15px] font-semibold">{row.documentTitle}</p>
            <BlankSentence blanks={row.blanks} fallback={row.detail} className="mt-1 text-[19px]" />
            <div className="mt-3 flex flex-wrap gap-2">
              <Button type="button" size="sm" onClick={() => onOpen(row)}>
                {row.row.action?.label ?? DOCUMENTS_WAITING_COPY.open}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => onOpenWork(row.workId)}>
                {DOCUMENTS_WAITING_COPY.openAlbatross}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The live section: the open handoffs, read again when the window comes back. */
export function DocumentsWaiting() {
  const [rows, setRows] = useState<DocumentWaitingRow[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch('/api/albatross/handoffs', { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .then((body: { ok?: boolean; items?: StepRunHandoffItem[] } | null) => {
          if (alive && body?.ok) setRows(documentsWaitingRows(body.items || []));
        })
        .catch(() => undefined);
    void load();
    window.addEventListener('focus', load);
    return () => {
      alive = false;
      window.removeEventListener('focus', load);
    };
  }, []);
  return (
    <DocumentsWaitingList
      rows={rows}
      onOpen={openWaitingDocument}
      onOpenWork={(workId) => openWorkPage({ getState: () => useClientStore.getState() }, workId)}
    />
  );
}
