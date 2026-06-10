export default function TermsPage() {
  return (
    <main className="min-h-dvh bg-[var(--color-bg)] px-5 py-10 text-[var(--color-text)]">
      <article className="mx-auto max-w-3xl space-y-5">
        <h1 className="text-2xl font-semibold">Terms of Service</h1>
        <p className="text-sm text-[var(--color-text-muted)]">Effective June 1, 2026</p>
        <p>
          Lab86 Mail is provided as hosted email productivity software. You are responsible for the accounts
          you connect, the actions you confirm, and compliance with your mail provider policies.
        </p>
        <p>
          AI-generated summaries, classifications, and drafts can be incomplete or incorrect. Review outbound
          mail before sending and verify important information independently.
        </p>
        <p>
          Paid plans are managed through Clerk Billing with Stripe payment processing. The B2C paid plan is
          offered at $15/month or $120/year unless updated in the hosted pricing page. Hosted AI use is
          protected by internal safeguards and may route to lower-cost models or pause chat when a period is
          exhausted. During launch, AI features may require your own provider API key.
        </p>
        <p>
          The service may be suspended or limited to protect users, providers, infrastructure, or billing
          systems from abuse, outages, or security risk.
        </p>
        <p>
          Questions:{' '}
          <a className="underline" href="mailto:support@lab86.io">
            support@lab86.io
          </a>
          .
        </p>
      </article>
    </main>
  );
}
