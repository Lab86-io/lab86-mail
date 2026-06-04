import { SignIn } from '@clerk/nextjs';

export default function SignInPage() {
  return (
    <main className="grid min-h-dvh place-items-center bg-[var(--color-bg)] px-4">
      <SignIn />
    </main>
  );
}
