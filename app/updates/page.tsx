import type { Metadata } from 'next';
import Link from 'next/link';
import { UpdateFeed } from '@/components/updates/UpdateFeed';
import { UpdatesSeen } from '@/components/updates/UpdatesSeen';
import { PRODUCT_UPDATES } from '@/lib/updates/feed';
import { APP_VERSION } from '@/lib/version';

export const metadata: Metadata = { title: 'What’s new · Albatross' };

export default function UpdatesPage() {
  return (
    <main className="app-paper min-h-dvh bg-[var(--color-bg)] text-[var(--color-text)]">
      <UpdatesSeen latestId={PRODUCT_UPDATES[0]?.id} />
      <div className="mx-auto max-w-2xl px-5 py-8 sm:px-8 sm:py-12">
        <Link
          href="/"
          className="mb-8 inline-flex items-center gap-1.5 rounded-sm text-[12.5px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        >
          Back to Albatross
        </Link>
        <header className="mb-8 border-b border-[var(--color-border)] pb-7">
          <div className="mb-3 flex items-center justify-between text-[11px] text-[var(--color-text-muted)]">
            <span className="font-medium">Albatross</span>
            <span>v{APP_VERSION}</span>
          </div>
          <h1 className="font-display text-[34px] tracking-tight">What’s new</h1>
          <p className="mt-2 text-[13.5px] text-[var(--color-text-muted)]">
            Little improvements. A little less on your shoulders.
          </p>
        </header>
        <UpdateFeed updates={PRODUCT_UPDATES} />
      </div>
    </main>
  );
}
