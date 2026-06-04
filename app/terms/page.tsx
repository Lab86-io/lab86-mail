export default function TermsPage() {
  return (
    <main className="min-h-dvh bg-[var(--color-bg)] px-5 py-10 text-[var(--color-text)]">
      <article className="mx-auto max-w-3xl space-y-5">
        <h1 className="text-2xl font-semibold">Terms of Service</h1>
        <p className="text-sm text-[var(--color-text-muted)]">Effective June 2026</p>
        <p>
          Lab86 Mail is provided as hosted email productivity software. You are responsible for the accounts
          you connect, the actions you confirm, and compliance with your mail provider policies.
        </p>
        <p>
          AI-generated summaries, classifications, and drafts can be incomplete or incorrect. Review outbound
          mail before sending and verify important information independently.
        </p>
        <p>
          Paid plans are managed through Clerk Billing with Stripe payment processing. Subscription access and
          included AI credits may change as the product evolves.
        </p>
        <p>
          The service may be suspended or limited to protect users, providers, infrastructure, or billing
          systems from abuse, outages, or security risk.
        </p>
        <p>Questions: support@lab86.io.</p>
      </article>
    </main>
  );
}
