import { SignUp } from '@clerk/nextjs';

export default function SignUpPage() {
  return (
    <main className="grid min-h-dvh place-items-center bg-[var(--color-bg)] px-4">
      <SignUp />
    </main>
  );
}
