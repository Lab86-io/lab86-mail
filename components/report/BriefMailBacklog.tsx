'use client';

export function BriefMailBacklog({
  items,
  onOpen,
}: {
  items: Array<{ account: string; threadId: string; subject: string; whyItMatters: string }>;
  onOpen: (account: string, threadId: string) => void;
}) {
  if (!items.length) return null;
  return (
    <details className="mx-auto mt-5 w-full max-w-[620px] rounded-[var(--radius-control)] border border-[var(--color-border)] text-sm">
      <summary className="cursor-pointer px-4 py-3">
        {items.length} more {items.length === 1 ? 'conversation' : 'conversations'} worth your attention
      </summary>
      <p className="px-4 pb-3 text-xs text-[var(--color-text-muted)]">
        These met your Brief criteria and are beyond this edition’s highlight limit.
      </p>
      <ul className="max-h-80 divide-y divide-[var(--color-border)] overflow-y-auto border-t border-[var(--color-border)]">
        {items.map((item) => (
          <li key={`${item.account}:${item.threadId}`}>
            <button
              type="button"
              onClick={() => onOpen(item.account, item.threadId)}
              className="w-full px-4 py-3 text-left hover:bg-[var(--color-bg-muted)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
            >
              <span className="block font-medium">{item.subject || '(no subject)'}</span>
              <span className="mt-1 block text-xs text-[var(--color-text-muted)]">{item.whyItMatters}</span>
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}
