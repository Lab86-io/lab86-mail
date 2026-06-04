export default function PrivacyPage() {
  return (
    <main className="min-h-dvh bg-[var(--color-bg)] px-5 py-10 text-[var(--color-text)]">
      <article className="mx-auto max-w-3xl space-y-5">
        <h1 className="text-2xl font-semibold">Privacy Policy</h1>
        <p className="text-sm text-[var(--color-text-muted)]">Effective June 2026</p>
        <p>
          Lab86 Mail connects to mail providers only after you authorize access. The app uses connected mail
          data to display messages, search, draft replies, summarize threads, and perform actions you request.
        </p>
        <p>
          Email content, account metadata, AI settings, usage records, and audit events may be stored in Lab86
          Mail systems to provide the service, enforce quotas, and troubleshoot account-specific issues.
        </p>
        <p>
          When Lab86 AI is enabled, relevant message content and instructions may be sent to configured AI
          providers to generate summaries, classifications, drafts, and other requested results.
          Bring-your-own key mode sends requests to the provider configured by the signed-in user.
        </p>
        <p>
          Lab86 Mail does not sell personal information. Provider access can be revoked from the connected
          account settings or from the underlying mail provider.
        </p>
        <p>Questions or deletion requests: support@lab86.io.</p>
      </article>
    </main>
  );
}
