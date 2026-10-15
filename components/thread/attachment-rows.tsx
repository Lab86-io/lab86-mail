'use client';

// The saved files that go with a draft (docs/albatross-goal-runs.md G3),
// as rows between the body and the bar: the name, the kind and the size,
// a note for a sealed file or a file that converts at send time, and
// "Remove". Shared by the inline composer, the compose overlay, and the
// draft tab of document mode.

import { fileKindWord, formatFileSize } from '@/lib/albatross/goal-run-view';
import type { DraftAttachment } from '@/lib/shared/types';
import { cn } from '@/lib/utils';

export const ATTACHMENT_COPY = {
  remove: 'Remove',
  removed: (name: string) => `Removed ${name}`,
  undo: 'Undo',
  converted: 'Converted to a PDF when you send.',
  sealed: 'A sealed field fills in when you send.',
  notSaved: 'Not saved yet',
} as const;

/** The sealed note of an attachment: the server's note when it sends one, else the fixed line for a sealed file. */
export function attachmentSealedNote(attachment: DraftAttachment): string | null {
  const extra = attachment as DraftAttachment & { sealed?: boolean; sealedNote?: string | null };
  if (extra.sealedNote?.trim()) return extra.sealedNote.trim();
  return extra.sealed ? ATTACHMENT_COPY.sealed : null;
}

/** "PDF, 84 KB" and the note that follows it. */
export function attachmentMeta(attachment: DraftAttachment): { line: string; note: string | null } {
  const kind = fileKindWord(attachment.contentType, attachment.name);
  const size = formatFileSize(attachment.size);
  const converts = attachment.format === 'pdf' && attachment.provider !== 'upload' && kind !== 'PDF';
  const line = size ? `${kind}, ${size}` : kind;
  return { line, note: attachmentSealedNote(attachment) ?? (converts ? ATTACHMENT_COPY.converted : null) };
}

export function AttachmentRows({
  attachments,
  onRemove,
  disabled,
  className,
}: {
  attachments: readonly DraftAttachment[];
  onRemove?: (attachment: DraftAttachment) => void;
  disabled?: boolean;
  className?: string;
}) {
  if (!attachments.length) return null;
  return (
    <ul data-slot="attachment-rows" className={cn('flex flex-col', className)}>
      {attachments.map((attachment) => {
        const meta = attachmentMeta(attachment);
        const sealed = attachmentSealedNote(attachment);
        return (
          <li
            key={`${attachment.provider}:${attachment.fileId}`}
            data-attachment-id={attachment.fileId}
            className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-ui px-2 py-1.5 hover:bg-[var(--color-hover-soft)]"
          >
            <span className="min-w-0 truncate text-[12.5px] font-medium">{attachment.name}</span>
            {onRemove ? (
              <button
                type="button"
                disabled={disabled}
                onClick={() => onRemove(attachment)}
                aria-label={`${ATTACHMENT_COPY.remove} ${attachment.name}`}
                className="row-span-2 text-[12px] text-[var(--color-text-muted)] opacity-0 hover:text-[var(--color-text)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:opacity-40 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
              >
                {ATTACHMENT_COPY.remove}
              </button>
            ) : (
              <span />
            )}
            <span className="min-w-0 text-[11px] text-[var(--color-text-faint)]">
              <span>{meta.line}</span>
              {meta.note ? (
                <span
                  className={cn(
                    'ml-1.5',
                    sealed ? 'text-[var(--color-accent-3)]' : 'text-[var(--color-text-faint)]',
                  )}
                >
                  {meta.note}
                </span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
