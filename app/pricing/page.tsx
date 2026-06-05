import { clerkBillingCheckoutUrl } from '@/lib/hosted/billing';
import { isSubscriptionServiceDisabled } from '@/lib/hosted/controls';

export default function PricingPage() {
  const checkoutUrl = clerkBillingCheckoutUrl();
  const subscriptionsDisabled = isSubscriptionServiceDisabled();
  return (
    <main className="min-h-dvh bg-[var(--color-bg)] px-5 py-10 text-[var(--color-text)]">
      <section className="mx-auto max-w-3xl space-y-6">
        <h1 className="text-2xl font-semibold">Lab86 Mail</h1>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-md border border-[var(--color-border)] p-4">
            <h2 className="font-semibold">Current launch access</h2>
            <p className="mt-2 text-sm text-[var(--color-text-muted)]">
              Connect mail accounts and use AI with your own OpenRouter key.
            </p>
          </div>
          <div className="rounded-md border border-[var(--color-border)] p-4">
            <h2 className="font-semibold">Pro</h2>
            <p className="mt-2 text-sm text-[var(--color-text-muted)]">
              $12 per month with 2,000,000 Lab86 AI credits. Subscriptions are paused while payment review
              completes.
            </p>
            {checkoutUrl && !subscriptionsDisabled ? (
              <a
                href={checkoutUrl}
                className="mt-4 inline-flex h-9 items-center rounded-md bg-[var(--color-accent)] px-3 text-sm font-medium text-[var(--color-accent-foreground)]"
              >
                Upgrade
              </a>
            ) : (
              <span className="mt-4 inline-flex h-9 items-center rounded-md border border-[var(--color-border)] px-3 text-sm text-[var(--color-text-muted)]">
                Coming soon
              </span>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
