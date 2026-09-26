import { PricingTable } from '@clerk/nextjs';
import { isClerkConfigured } from '@/lib/hosted/env';
import { PAID_PLANS, PRODUCT_NAME, planPriceLine } from '@/lib/hosted/plans';

export const dynamic = 'force-dynamic';

export default function PricingPage() {
  const clerkConfigured = isClerkConfigured();
  return (
    <main className="min-h-dvh bg-[var(--color-bg)] px-5 py-10 text-[var(--color-text)]">
      <section className="mx-auto max-w-4xl space-y-6">
        <h1 className="text-2xl font-semibold">{PRODUCT_NAME}</h1>
        <p className="max-w-2xl text-sm text-[var(--color-text-muted)]">
          Two plans, one product. {PAID_PLANS.pro.name} ({planPriceLine('pro')}) includes hosted models with a
          monthly budget. {PAID_PLANS.byok.name} ({planPriceLine('byok')}) unlocks the same full feature set
          with your own OpenRouter, OpenAI, or Anthropic API key. You pay your model provider directly.
        </p>
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
