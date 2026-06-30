import { SignIn } from '@clerk/nextjs';
import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { DotGridGlow } from '@/components/ui/dot-grid-glow';
import { isClerkConfigured } from '@/lib/hosted/env';

export default async function SignInPage() {
  if (!isClerkConfigured()) {
    return (
      <main className="grid min-h-dvh place-items-center bg-[var(--color-bg)] px-4">
        <div className="max-w-sm rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-5 text-center">
          <h1 className="text-base font-semibold text-[var(--color-text)]">Sign in unavailable</h1>
          <p className="mt-2 text-sm text-[var(--color-text-muted)]">Authentication is not configured.</p>
        </div>
      </main>
    );
  }

  const session = await auth();
  if (session.userId) redirect('/');

  return (
    <main className="app-paper relative grid min-h-dvh place-items-center px-4 py-10">
      <DotGridGlow />
      <div className="relative z-10 flex w-full max-w-4xl flex-col items-center gap-10 md:flex-row md:justify-center md:gap-16">
        <div className="max-w-sm text-center md:text-left">
          <div className="text-[13px] font-medium uppercase tracking-[0.2em] text-[var(--color-accent)]">
            Lab86 Mail
          </div>
          <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-tight text-[var(--color-text)]">
            All your mail, one sharp inbox.
          </h1>
          <p className="mt-3 text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
            Gmail, Outlook, and iCloud together — instant private search, smart triage, an AI chief-of-staff,
            and a daily brief that actually reads your mail.
          </p>
        </div>
        <SignIn
          fallbackRedirectUrl="/"
          forceRedirectUrl="/"
          signUpFallbackRedirectUrl="/"
          signUpForceRedirectUrl="/"
          signUpUrl="/sign-up"
        />
      </div>
    </main>
  );
}
