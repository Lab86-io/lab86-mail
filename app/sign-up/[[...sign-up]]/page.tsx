import { SignUp } from '@clerk/nextjs';
import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { DotGridGlow } from '@/components/ui/dot-grid-glow';
import { isPublicSignupDisabled } from '@/lib/hosted/controls';
import { isClerkConfigured } from '@/lib/hosted/env';

export default async function SignUpPage() {
  if (!isClerkConfigured()) {
    return (
      <main className="grid min-h-dvh place-items-center bg-[var(--color-bg)] px-4">
        <div className="max-w-sm rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-5 text-center">
          <h1 className="text-base font-semibold text-[var(--color-text)]">Sign up unavailable</h1>
          <p className="mt-2 text-sm text-[var(--color-text-muted)]">Authentication is not configured.</p>
        </div>
      </main>
    );
  }

  const session = await auth();
  if (session.userId) redirect('/');

  if (isPublicSignupDisabled()) {
    return (
      <main className="grid min-h-dvh place-items-center bg-[var(--color-bg)] px-4">
        <div className="max-w-sm rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-5 text-center">
          <h1 className="text-base font-semibold text-[var(--color-text)]">Signups are paused</h1>
          <p className="mt-2 text-sm text-[var(--color-text-muted)]">
            Lab86 Mail is temporarily not accepting new accounts.
          </p>
        </div>
      </main>
    );
  }
  return (
    <main className="app-paper relative grid min-h-dvh place-items-center px-4 py-10">
      <DotGridGlow />
      <div className="relative z-10">
        <SignUp
          fallbackRedirectUrl="/"
          forceRedirectUrl="/"
          signInFallbackRedirectUrl="/"
          signInForceRedirectUrl="/"
          signInUrl="/sign-in"
        />
      </div>
    </main>
  );
}
