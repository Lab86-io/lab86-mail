'use client';

// Document mode in the Albatross thread (docs/albatross-document-handoff.md, D5).
// The document fills the center; the thread moves to the right with the
// "Your part" card on top. The chat beside it edits the document, and
// "Done, continue" marks the step done so that Albatross goes on.

import dynamic from 'next/dynamic';
import { type ReactNode, useState } from 'react';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { BlankSentence } from '@/components/albatross/BlankSentence';
import { Button } from '@/components/ui/button';
import { DOCUMENT_HANDOFF_COPY } from '@/lib/albatross/document-handoff';
import type { DocumentTarget } from '@/lib/albatross/step-run-client';
import { cn } from '@/lib/utils';

function EditorLoading() {
  return (
    <div className="flex h-full items-center justify-center text-[12.5px] text-[var(--color-text-muted)]">
      The document opens in a moment.
    </div>
  );
}

// The editors are large; the thread loads them only when a document opens.
const DocumentEditor = dynamic(
  () => import('@/components/files/DocumentEditor').then((module) => module.DocumentEditor),
  { ssr: false, loading: EditorLoading },
);
const OfficeEditor = dynamic(
  () => import('@/components/files/OfficeEditor').then((module) => module.OfficeEditor),
  { ssr: false, loading: EditorLoading },
);

export function ThreadDocumentEditor({
  target,
  onClose,
  onChat,
}: {
  target: DocumentTarget;
  onClose: () => void;
  onChat?: () => void;
}) {
  return target.provider === 'office' ? (
    <OfficeEditor key={target.id} documentId={target.id} host="thread" onClose={onClose} onChat={onChat} />
  ) : (
    <DocumentEditor key={target.id} documentId={target.id} host="thread" onClose={onClose} />
  );
}

/** The card on top of the thread column: what the user does in the document, and the way on. */
export function YourPartCard({
  stepLabel,
  detail,
  blanks = [],
  busy,
  error,
  onDone,
  onBack,
}: {
  /** "Step 2: Make the hours summary and invoice". */
  stepLabel: string | null;
  detail: string;
  /** The empty fields the user fills in (lib/albatross/blanks.ts). */
  blanks?: readonly string[];
  busy: boolean;
  error: string | null;
  onDone: () => void;
  onBack: () => void;
}) {
  return (
    <section
      data-slot="document-your-part"
      aria-label={DOCUMENT_HANDOFF_COPY.yourPart}
      className="flex shrink-0 flex-col gap-1.5 border-b border-[var(--color-border)] px-4 pb-3.5 pt-3"
    >
      {stepLabel ? (
        <span className="min-w-0 truncate text-[11.5px] text-[var(--color-text-faint)]">{stepLabel}</span>
      ) : null}
      <BlankSentence
        blanks={blanks}
        fallback={detail}
        className={blanks.length ? 'text-[20px]' : 'text-[17px]'}
      />
      {blanks.length ? (
        <p className="text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">{detail}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button type="button" size="sm" disabled={busy} onClick={onDone}>
          {busy ? DOCUMENT_HANDOFF_COPY.saving : DOCUMENT_HANDOFF_COPY.done}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onBack}>
          {DOCUMENT_HANDOFF_COPY.backToThread}
        </Button>
      </div>
      {error ? <p className="text-[11.5px] text-[var(--color-danger)]">{error}</p> : null}
    </section>
  );
}

/** Narrow screens: the document is full screen, and this bar holds the way on and the chat. */
export function YourPartBar({
  detail,
  blanks = [],
  busy,
  error,
  onDone,
  onChat,
}: {
  detail: string | null;
  blanks?: readonly string[];
  busy: boolean;
  error: string | null;
  onDone: (() => void) | null;
  onChat: () => void;
}) {
  return (
    <div
      data-slot="document-your-part-bar"
      className="flex shrink-0 flex-col gap-2 border-t border-[var(--color-border)] bg-[var(--color-bg)] px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2.5"
    >
      {detail && blanks.length ? (
        <BlankSentence blanks={blanks} className="text-[16px]" />
      ) : detail ? (
        <p className="line-clamp-2 text-[13px] leading-snug">{detail}</p>
      ) : null}
      <div className="flex items-center gap-2">
        {onDone ? (
          <Button type="button" size="sm" disabled={busy} onClick={onDone}>
            {busy ? DOCUMENT_HANDOFF_COPY.saving : DOCUMENT_HANDOFF_COPY.done}
          </Button>
        ) : null}
        <Button type="button" size="sm" variant="outline" onClick={onChat}>
          {DOCUMENT_HANDOFF_COPY.chat}
        </Button>
      </div>
      {error ? <p className="text-[11.5px] text-[var(--color-danger)]">{error}</p> : null}
    </div>
  );
}

/** The docked split of document mode: the document in the center, the thread on the right. */
export function DocumentSplit({ document, conversation }: { document: ReactNode; conversation: ReactNode }) {
  const [resizing, setResizing] = useState(false);
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: 'lab86-mail-thread-document-split',
    panelIds: ['document', 'conversation'],
    storage: typeof window !== 'undefined' ? window.localStorage : noopStorage,
  });
  return (
    <Group
      orientation="horizontal"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
      data-panel-resizing={resizing || undefined}
      className="h-full min-h-0 w-full"
    >
      <Panel id="document" defaultSize="64%" minSize="480px">
        {/* A drag must not fall into the Word editor's frame. */}
        <div
          data-thread-region="document"
          className={cn('h-full min-h-0', resizing && '[&_iframe]:pointer-events-none')}
        >
          {document}
        </div>
      </Panel>
      <Separator
        onPointerDown={() => {
          const end = () => {
            window.removeEventListener('pointerup', end);
            window.removeEventListener('blur', end);
            setResizing(false);
          };
          setResizing(true);
          window.addEventListener('pointerup', end);
          window.addEventListener('blur', end);
        }}
        aria-label="Resize the document and the conversation"
        className="group relative w-[6px] shrink-0 cursor-col-resize outline-none"
      >
        <span
          className="pointer-events-none absolute bottom-0 left-1/2 top-0 w-px -translate-x-1/2 bg-[var(--color-border)] transition-colors group-hover:bg-[var(--color-accent)] group-data-[separator-state=drag]:w-[2px] group-data-[separator-state=drag]:bg-[var(--color-accent)]"
          aria-hidden
        />
      </Separator>
      <Panel id="conversation" defaultSize="36%" minSize="360px" maxSize="52%">
        {conversation}
      </Panel>
    </Group>
  );
}

const noopStorage: Pick<Storage, 'getItem' | 'setItem'> = { getItem: () => null, setItem: () => undefined };
