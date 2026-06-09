import { SignIn } from '@clerk/nextjs';
import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';

export default async function SignInPage() {
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
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
    <main className="grid min-h-dvh place-items-center bg-[var(--color-bg)] px-4">
      <SignIn
        fallbackRedirectUrl="/"
        forceRedirectUrl="/"
        signUpFallbackRedirectUrl="/"
        signUpForceRedirectUrl="/"
        signUpUrl="/sign-up"
      />
    </main>
  );
}
