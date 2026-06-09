import { PricingTable } from '@clerk/nextjs';
import { isClerkConfigured } from '@/lib/hosted/env';

export const dynamic = 'force-dynamic';

export default function PricingPage() {
  const clerkConfigured = isClerkConfigured();
  return (
    <main className="min-h-dvh bg-[var(--color-bg)] px-5 py-10 text-[var(--color-text)]">
      <section className="mx-auto max-w-4xl space-y-6">
        <h1 className="text-2xl font-semibold">Lab86 Mail</h1>
        {clerkConfigured ? (
          <PricingTable />
        ) : (
          <div className="rounded-md border border-[var(--color-border)] p-4 text-sm text-[var(--color-text-muted)]">
            Billing is available in hosted environments.
          </div>
        )}
      </section>
    </main>
  );
}
