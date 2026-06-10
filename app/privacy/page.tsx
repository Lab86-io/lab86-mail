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
          The data we process can include account identifiers, connected-provider metadata, message headers,
          message bodies, snippets, labels, attachments that you open or send, drafts, outbound send metadata,
          AI settings, billing entitlement records, usage records, rate-limit counters, and security audit
          events. We store the minimum app state needed to operate Lab86 Mail, including a Convex-backed local
          mail corpus used for search and synchronization.
        </p>
        <p>
          When Lab86 AI is enabled, relevant message content and instructions may be sent to configured AI
          providers to generate summaries, classifications, drafts, and other requested results.
          Bring-your-own key mode sends requests to the provider configured by the signed-in user.
        </p>
        <p>
          Lab86 Mail&apos;s use and transfer of information received from Google APIs adheres to the{' '}
          <a className="underline" href="https://developers.google.com/terms/api-services-user-data-policy">
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements. We do not sell Google user data, use it for advertising,
          use it to train generalized AI or machine learning models, or allow humans to read message content
          except with your consent, for security, to comply with law, or for support you request.
        </p>
        <p>
          Lab86 Mail does not sell personal information. We use service providers to run the product,
          including Railway, Convex, Nylas, Clerk, Stripe, OpenRouter, OpenAI, Anthropic, and comparable AI
          providers selected in your account settings. These providers process data only to provide, secure,
          bill, or support Lab86 Mail.
        </p>
        <p>
          Disconnecting a provider revokes the hosted grant and deletes Lab86-hosted grant records, cached
          thread/message data, corpus rows, sync state, and provider webhook records for that mailbox. Account
          deletion removes your Lab86-hosted account data, AI settings, usage records, corpus data, and
          connected mail grants. These actions do not delete messages from the original mail provider mailbox
          unless you separately perform a delete action in that provider.
        </p>
        <p>
          Questions, privacy requests, or deletion requests:{' '}
          <a className="underline" href="mailto:support@lab86.io">
            support@lab86.io
          </a>
          . Security reports:{' '}
          <a className="underline" href="mailto:security@lab86.io">
            security@lab86.io
          </a>
          .
        </p>
      </article>
    </main>
  );
}
