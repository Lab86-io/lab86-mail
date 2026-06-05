import { SignUp } from '@clerk/nextjs';
import { isPublicSignupDisabled } from '@/lib/hosted/controls';

export default function SignUpPage() {
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    return (
      <main className="grid min-h-dvh place-items-center bg-[var(--color-bg)] px-4">
        <div className="max-w-sm rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-5 text-center">
          <h1 className="text-base font-semibold text-[var(--color-text)]">Sign up unavailable</h1>
          <p className="mt-2 text-sm text-[var(--color-text-muted)]">Authentication is not configured.</p>
        </div>
      </main>
    );
  }

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
    <main className="grid min-h-dvh place-items-center bg-[var(--color-bg)] px-4">
      <SignUp />
    </main>
  );
}
