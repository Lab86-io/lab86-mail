import { PricingTable } from '@clerk/nextjs';
import {
  B2C_ANNUAL_PRICE_USD,
  B2C_BYOK_ANNUAL_PRICE_USD,
  B2C_BYOK_MONTHLY_PRICE_USD,
  B2C_MONTHLY_PRICE_USD,
} from '@/lib/ai/budget';
import { isClerkConfigured } from '@/lib/hosted/env';

export const dynamic = 'force-dynamic';

export default function PricingPage() {
  const clerkConfigured = isClerkConfigured();
  return (
    <main className="min-h-dvh bg-[var(--color-bg)] px-5 py-10 text-[var(--color-text)]">
      <section className="mx-auto max-w-4xl space-y-6">
        <h1 className="text-2xl font-semibold">Lab86 Mail</h1>
        <p className="max-w-2xl text-sm text-[var(--color-text-muted)]">
          Two plans, one product. Pro (${B2C_MONTHLY_PRICE_USD}/month or ${B2C_ANNUAL_PRICE_USD}/year)
          includes Lab86-hosted AI with a monthly usage budget. Bring-your-own-key ($
          {B2C_BYOK_MONTHLY_PRICE_USD}/month or ${B2C_BYOK_ANNUAL_PRICE_USD}/year) unlocks the same full
          feature set with your own OpenRouter, OpenAI, or Anthropic API key — you pay your model provider
          directly.
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
