export default function SupportPage() {
  return (
    <main className="min-h-dvh bg-[var(--color-bg)] px-5 py-10 text-[var(--color-text)]">
      <article className="mx-auto max-w-3xl space-y-5">
        <h1 className="text-2xl font-semibold">Support</h1>
        <p>
          For account, billing, privacy, or provider connection help, contact{' '}
          <a href="mailto:support@lab86.io" className="underline">
            support@lab86.io
          </a>
          .
        </p>
        <p className="text-sm text-[var(--color-text-muted)]">
          Include the email address on your Lab86 Mail account, the connected provider, and the approximate
          time of the issue. Do not send passwords or provider API keys.
        </p>
        <p>
          To delete your account, open Accounts and AI in the app settings and choose Delete. You can also
          email{' '}
          <a href="mailto:support@lab86.io" className="underline">
            support@lab86.io
          </a>{' '}
          from the address on your Lab86 Mail account.
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
