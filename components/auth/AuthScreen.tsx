import Link from 'next/link';
import type { ReactNode } from 'react';
import { DotGridGlow } from '@/components/ui/dot-grid-glow';
import { COMPANY_NAME, PRODUCT_NAME } from '@/lib/hosted/plans';

// The public face of the app: signed-out visits to / land on /sign-in, so
// this screen names the product, says what it does, and links the legal
// pages (Google OAuth verification checks all three on the home page).
export const AUTH_PRODUCT_LINE = `${PRODUCT_NAME} is an email and calendar app from ${COMPANY_NAME} that sorts your mail, shows your calendar and tasks, and writes you a brief each morning.`;

export const AUTH_LEGAL_LINKS = [
  { href: '/privacy', label: 'Privacy' },
  { href: '/terms', label: 'Terms' },
] as const;

/** Sign-in and sign-up layout: the product introduction beside the Clerk form, legal links below. */
export function AuthScreen({ children }: { children: ReactNode }) {
  return (
    <main className="app-paper relative flex min-h-dvh flex-col px-4">
      <DotGridGlow />
      <div className="relative z-10 flex flex-1 items-center justify-center py-10">
        <div className="flex w-full max-w-4xl flex-col items-center gap-10 md:flex-row md:justify-center md:gap-16">
          <div className="max-w-sm text-center md:text-left">
            <div className="text-[13px] font-medium text-[var(--color-accent)]">{PRODUCT_NAME}</div>
            <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-tight text-[var(--color-text)]">
              Tell it what is weighing on you.
            </h1>
            <p className="mt-3 text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
              Albatross works out what you actually want, finds the context across your mail and calendar,
              carries the parts it can, and tells you when something is genuinely done.
            </p>
            <p className="mt-3 text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
              {AUTH_PRODUCT_LINE}
            </p>
          </div>
          {children}
        </div>
      </div>
      <AuthFooter />
    </main>
  );
}

/** The quiet legal row under the sign-in form: the product and company, then Privacy and Terms. */
export function AuthFooter() {
  return (
    <footer className="relative z-10 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 pb-6 text-[12px] text-[var(--color-text-muted)]">
      <span>
        {PRODUCT_NAME} from {COMPANY_NAME}
      </span>
      {AUTH_LEGAL_LINKS.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className="underline-offset-2 transition-colors hover:text-[var(--color-text)] hover:underline"
        >
          {link.label}
        </Link>
      ))}
    </footer>
  );
}
