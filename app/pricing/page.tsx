import { PricingTable } from '@clerk/nextjs';
import Link from 'next/link';
import { isClerkConfigured } from '@/lib/hosted/env';
import {
  COMPANY_NAME,
  FREE_PLAN_NAME,
  PAID_PLANS,
  PRODUCT_NAME,
  planTableRows,
  pricingFaq,
  SUPPORT_EMAIL,
  TRIAL_DAYS,
} from '@/lib/hosted/plans';

export const dynamic = 'force-dynamic';

export default function PricingPage() {
  const clerkConfigured = isClerkConfigured();
  const rows = planTableRows();
  const plans = [
    { id: 'free', name: FREE_PLAN_NAME },
    { id: 'pro', name: PAID_PLANS.pro.name },
    { id: 'byok', name: PAID_PLANS.byok.name },
  ] as const;
  return (
    <main className="min-h-dvh bg-[var(--color-bg)] px-5 py-12 text-[var(--color-text)]">
      <div className="mx-auto max-w-4xl space-y-14">
        <header className="space-y-4">
          <p className="text-[13px] font-medium text-[var(--color-text-muted)]">{PRODUCT_NAME}</p>
          <h1 className="max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">
            Start each morning knowing what needs you.
          </h1>
          <p className="max-w-2xl text-[15px] leading-relaxed text-[var(--color-text-muted)]">
            {PRODUCT_NAME} reads your mail and calendar and writes one Brief each morning: what to answer,
            what waits on other people, and what to do today. Then it helps you finish the work, and asks
            before it acts for you.
          </p>
          <p className="text-[14px]">
            Try {PAID_PLANS.pro.name} free for {TRIAL_DAYS} days. No card. When the trial ends, your account
            moves to {FREE_PLAN_NAME}, and nothing is charged.
          </p>
        </header>

        <section aria-labelledby="plans" className="space-y-4">
          <h2 id="plans" className="text-xl font-semibold">
            Plans
          </h2>
          {/* Below sm, one card per plan with the same rows, so nothing
              scrolls sideways. The table stays for wider screens. */}
          <div className="grid gap-3 sm:hidden">
            {plans.map((plan) => (
              <section
                key={plan.id}
                data-plan-card={plan.id}
                aria-labelledby={`plan-card-${plan.id}`}
                className="rounded-xl border border-[var(--color-border)]"
              >
                <h3
                  id={`plan-card-${plan.id}`}
                  className="border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-3 text-[14px] font-semibold"
                >
                  {plan.name}
                </h3>
                <dl className="divide-y divide-[var(--color-border)] text-[13px]">
                  {rows.map((row) => (
                    <div
                      key={row.feature}
                      className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3 px-4 py-2.5"
                    >
                      <dt className="font-medium">{row.feature}</dt>
                      <dd className="text-[var(--color-text-muted)]">{row[plan.id]}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
          <div className="hidden overflow-x-auto rounded-xl border border-[var(--color-border)] sm:block">
            <table className="w-full border-collapse text-left text-[13px]">
              <thead>
                <tr className="border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
                  <th scope="col" className="px-4 py-3 font-medium text-[var(--color-text-muted)]">
                    <span className="sr-only">Feature</span>
                  </th>
                  {plans.map((plan) => (
                    <th key={plan.id} scope="col" className="px-4 py-3 font-semibold">
                      {plan.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.feature} className="border-b border-[var(--color-border)] last:border-b-0">
                    <th scope="row" className="px-4 py-3 font-medium">
                      {row.feature}
                    </th>
                    {plans.map((plan) => (
                      <td key={plan.id} className="px-4 py-3 text-[var(--color-text-muted)]">
                        {row[plan.id]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section aria-labelledby="budget" className="space-y-4">
          <h2 id="budget" className="text-xl font-semibold">
            What {PAID_PLANS.pro.name} pays for
          </h2>
          <dl className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-xl border border-[var(--color-border)] p-4">
              <dt className="font-medium">Every morning</dt>
              <dd className="mt-1 text-[13px] leading-relaxed text-[var(--color-text-muted)]">
                The Brief is written each morning. The monthly budget never stops it.
              </dd>
            </div>
            <div className="rounded-xl border border-[var(--color-border)] p-4">
              <dt className="font-medium">All day</dt>
              <dd className="mt-1 text-[13px] leading-relaxed text-[var(--color-text-muted)]">
                Sorting and drafts run on every new message. Near the end of the budget they use lower-cost
                models, and they do not stop.
              </dd>
            </div>
            <div className="rounded-xl border border-[var(--color-border)] p-4">
              <dt className="font-medium">When you ask</dt>
              <dd className="mt-1 text-[13px] leading-relaxed text-[var(--color-text-muted)]">
                Chat uses a monthly model budget. When it is used up, chat waits for the next month, or you
                can add your own key. Sorting, drafts, and the Brief keep running.
              </dd>
            </div>
          </dl>
        </section>

        <section aria-labelledby="data" className="space-y-3">
          <h2 id="data" className="text-xl font-semibold">
            Your data stays yours
          </h2>
          <p className="max-w-2xl text-[14px] leading-relaxed text-[var(--color-text-muted)]">
            {COMPANY_NAME} does not train models on your mail, your calendar, or anything you write in{' '}
            {PRODUCT_NAME}, and does not sell your data. A model provider gets only what one request needs,
            only to answer it. You can export everything at any time, and delete your account in one step.
          </p>
        </section>

        <section aria-labelledby="faq" className="space-y-3">
          <h2 id="faq" className="text-xl font-semibold">
            Questions
          </h2>
          <div className="divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)]">
            {pricingFaq().map((entry) => (
              <details key={entry.question} className="group px-4 py-3">
                <summary className="cursor-pointer text-[14px] font-medium">{entry.question}</summary>
                <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-text-muted)]">
                  {entry.answer}
                </p>
              </details>
            ))}
          </div>
        </section>

        <section aria-labelledby="choose" className="space-y-4">
          <h2 id="choose" className="text-xl font-semibold">
            Choose a plan
          </h2>
          {clerkConfigured ? (
            <PricingTable />
          ) : (
            <div className="rounded-md border border-[var(--color-border)] p-4 text-sm text-[var(--color-text-muted)]">
              Billing is available in hosted environments.
            </div>
          )}
        </section>

        <footer className="flex flex-wrap gap-4 border-t border-[var(--color-border)] pt-6 text-[12px] text-[var(--color-text-muted)]">
          <Link href="/terms" className="underline">
            Terms
          </Link>
          <Link href="/privacy" className="underline">
            Privacy
          </Link>
          <Link href="/support" className="underline">
            Support
          </Link>
          <a href={`mailto:${SUPPORT_EMAIL}`} className="underline">
            {SUPPORT_EMAIL}
          </a>
        </footer>
      </div>
    </main>
  );
}
