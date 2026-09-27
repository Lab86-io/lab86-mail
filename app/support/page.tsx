import Link from 'next/link';
import {
  FREE_PLAN_NAME,
  PAID_PLANS,
  PRODUCT_NAME,
  planPriceLine,
  SUPPORT_EMAIL,
  TRIAL_DAYS,
} from '@/lib/hosted/plans';

export default function SupportPage() {
  return (
    <main className="min-h-dvh bg-[var(--color-bg)] px-5 py-10 text-[var(--color-text)]">
      <article className="mx-auto max-w-3xl space-y-5">
        <h1 className="text-2xl font-semibold">Support</h1>
        <p>
          For account, billing, privacy, or provider connection help, contact{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="underline">
            {SUPPORT_EMAIL}
          </a>
          .
        </p>
        <p className="text-sm text-[var(--color-text-muted)]">
          Include the email address on your {PRODUCT_NAME} account, the connected provider, and the
          approximate time of the issue. Do not send passwords or provider API keys.
        </p>
        <h2 className="pt-2 text-lg font-semibold">Plans and billing</h2>
        <p>
          {PAID_PLANS.pro.name} costs {planPriceLine('pro')}. {PAID_PLANS.byok.name} costs{' '}
          {planPriceLine('byok')}. A new account gets {TRIAL_DAYS} days of {PAID_PLANS.pro.name} with no card.
          When the trial ends, the account moves to {FREE_PLAN_NAME}, and nothing is charged. To change or
          cancel a plan, open Settings, Intelligence, and choose Manage. The{' '}
          <Link href="/pricing" className="underline">
            pricing page
          </Link>{' '}
          compares the plans.
        </p>
        <h2 className="pt-2 text-lg font-semibold">Your data</h2>
        <p>
          To download a copy of your data, open Settings, Account, and choose Export my data. To delete your
          account, open Settings, Account, and choose Delete account. You can also email{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="underline">
            {SUPPORT_EMAIL}
          </a>{' '}
          from the address on your {PRODUCT_NAME} account.
        </p>
        <p>
          Security reports should go to{' '}
          <a href="mailto:security@lab86.io" className="underline">
            security@lab86.io
          </a>
          . Include the affected endpoint or provider, timestamps, and any safe reproduction details. Do not
          include secrets, access tokens, or full message bodies unless requested for incident response.
        </p>
      </article>
    </main>
  );
}
