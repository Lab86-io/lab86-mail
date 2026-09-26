import {
  COMPANY_NAME,
  FREE_PLAN_NAME,
  PAID_PLANS,
  PRODUCT_NAME,
  planPriceLine,
  SUPPORT_EMAIL,
  TRIAL_DAYS,
} from '@/lib/hosted/plans';

export default function TermsPage() {
  return (
    <main className="min-h-dvh bg-[var(--color-bg)] px-5 py-10 text-[var(--color-text)]">
      <article className="mx-auto max-w-3xl space-y-5">
        <h1 className="text-2xl font-semibold">Terms of Service</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          Effective June 1, 2026. Updated September 26, 2026.
        </p>
        <p>
          {PRODUCT_NAME} is hosted email and personal operations software from {COMPANY_NAME}. You are
          responsible for the accounts you connect, the actions you confirm, and compliance with your mail
          provider policies.
        </p>
        <p>
          You may connect only mailboxes you are authorized to access. Revoking provider access or deleting
          your {PRODUCT_NAME} account can permanently remove {COMPANY_NAME}-hosted grants, cached mail data,
          corpus records, model settings, and usage records. It does not delete mail that remains in your
          original provider mailbox. You can export your data from Settings before you delete your account.
        </p>
        <p>
          Summaries, classifications, and drafts that {PRODUCT_NAME} writes with language models can be
          incomplete or incorrect. Review outbound mail before sending and verify important information
          independently.
        </p>
        <p>
          Paid plans are managed through Clerk Billing with Stripe payment processing. {PAID_PLANS.pro.name}{' '}
          costs {planPriceLine('pro')}. {PAID_PLANS.byok.name} costs {planPriceLine('byok')}. A new account
          gets {TRIAL_DAYS} days of {PAID_PLANS.pro.name} with no card; when the trial ends, the account moves
          to {FREE_PLAN_NAME} and nothing is charged. Hosted model use is protected by internal safeguards and
          may route to lower-cost models or pause chat when a billing period&apos;s budget is used up.
        </p>
        <p>
          The service may be suspended or limited to protect users, providers, infrastructure, or billing
          systems from abuse, outages, or security risk.
        </p>
        <p>
          Do not use {PRODUCT_NAME} to send spam, violate provider rules, access another person&apos;s mailbox
          without authorization, or process regulated data unless {COMPANY_NAME} has agreed to the required
          contractual terms in writing.
        </p>
        <p>
          Questions:{' '}
          <a className="underline" href={`mailto:${SUPPORT_EMAIL}`}>
            {SUPPORT_EMAIL}
          </a>
          .
        </p>
      </article>
    </main>
  );
}
