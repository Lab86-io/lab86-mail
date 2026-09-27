import { COMPANY_NAME, PRODUCT_NAME, SUPPORT_EMAIL } from '@/lib/hosted/plans';

export default function PrivacyPage() {
  return (
    <main className="min-h-dvh bg-[var(--color-bg)] px-5 py-10 text-[var(--color-text)]">
      <article className="mx-auto max-w-3xl space-y-5">
        <h1 className="text-2xl font-semibold">Privacy Policy</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          Effective June 2026. Updated September 27, 2026.
        </p>
        <p>
          {PRODUCT_NAME} is hosted email and personal operations software from {COMPANY_NAME}. This policy
          explains what data {PRODUCT_NAME} collects, how it uses and shares that data, how long it keeps it,
          and the choices you have.
        </p>

        <h2 className="pt-2 text-lg font-semibold">Data we collect</h2>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong>Account data:</strong> your name, email address, and sign-in records, through our sign-in
            provider Clerk.
          </li>
          <li>
            <strong>Connected mailbox data:</strong> after you connect a mailbox, {PRODUCT_NAME} connects to
            your mail provider only with the access you authorize. It processes message headers, message
            bodies, snippets, labels, attachments that you open or send, drafts, and outbound send metadata.
          </li>
          <li>
            <strong>Calendar and file data:</strong> calendar events when you connect a calendar, and files
            when you connect a file service such as Google Drive.
          </li>
          <li>
            <strong>Content you create:</strong> tasks, notes, plans, rules, labels, saved replies,
            signatures, and settings.
          </li>
          <li>
            <strong>Billing data:</strong> your plan and billing entitlement records. Stripe processes card
            payments through Clerk Billing. {COMPANY_NAME} does not receive or store card numbers.
          </li>
          <li>
            <strong>Usage and security data:</strong> usage records, rate-limit counters, security audit
            events, and device tokens for notifications that you turn on.
          </li>
        </ul>

        <h2 className="pt-2 text-lg font-semibold">How we use data</h2>
        <p>
          We use your data only to provide the features you use: to show, search, and sort your mail, to draft
          replies and summaries, to prepare your brief, to perform actions you request, to send notifications
          you turn on, to bill your plan, and to keep the service secure. We store the minimum app state
          needed to operate {PRODUCT_NAME}, including a Convex-backed mail index used for search and
          synchronization.
        </p>
        <p>
          When the assistant is enabled, relevant message content and instructions may be sent to configured
          AI providers to generate summaries, classifications, drafts, and other requested results. These
          providers process the data to return a result to you. Bring-your-own key mode sends requests to the
          provider configured by the signed-in user.
        </p>

        <h2 className="pt-2 text-lg font-semibold">Google user data</h2>
        <p>
          {PRODUCT_NAME}&apos;s use and transfer of information received from Google APIs adheres to the{' '}
          <a className="underline" href="https://developers.google.com/terms/api-services-user-data-policy">
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements. When you connect a Google account, {PRODUCT_NAME} uses the
          Gmail access you grant to read, sort, label, draft, and send mail for you, and uses your Google
          email address to identify the connected account. If you connect Google Drive, {PRODUCT_NAME} uses
          that access to find, open, and create the files you ask for.
        </p>
        <p>
          We do not sell Google user data, use it for advertising, use it to train generalized AI or machine
          learning models, or allow humans to read message content except with your consent, for security, to
          comply with law, or for support you request.
        </p>

        <h2 className="pt-2 text-lg font-semibold">How we share data</h2>
        <p>
          {PRODUCT_NAME} does not sell personal information. We use service providers to run the product,
          including Railway, Convex, Nylas, Clerk, Stripe, Resend, OpenRouter, OpenAI, Anthropic, and
          comparable AI providers selected in your account settings. These providers process data only to
          provide, secure, bill, or support {PRODUCT_NAME}. We may also disclose data when the law requires it
          or to protect users and the service from fraud or abuse.
        </p>

        <h2 className="pt-2 text-lg font-semibold">Security</h2>
        <p>
          Data moves between your device, {PRODUCT_NAME}, and our service providers over encrypted (TLS)
          connections. Model provider keys that you add are encrypted before we store them. Access to
          production systems is limited to the people who operate the service.
        </p>

        <h2 className="pt-2 text-lg font-semibold">Retention and deletion</h2>
        <p>
          We keep your data while your account is active. Disconnecting a provider revokes the hosted grant
          and deletes {COMPANY_NAME}-hosted grant records, cached thread and message data, index rows, sync
          state, and provider webhook records for that mailbox. Account deletion removes your {COMPANY_NAME}
          -hosted account data, AI settings, usage records, index data, and connected mail grants. Processed
          provider webhook events are deleted after 14 days. These actions do not delete messages from the
          original mail provider mailbox unless you separately perform a delete action in that provider.
        </p>

        <h2 className="pt-2 text-lg font-semibold">Your choices</h2>
        <ul className="list-disc space-y-2 pl-5">
          <li>Export your data from Settings at any time.</li>
          <li>Disconnect a mailbox and its calendar from Settings, or Google Drive from Files.</li>
          <li>Delete your account from Settings, or ask us to delete it.</li>
          <li>
            Remove {PRODUCT_NAME}&apos;s access to your Google account at{' '}
            <a className="underline" href="https://myaccount.google.com/permissions">
              myaccount.google.com/permissions
            </a>
            .
          </li>
        </ul>

        <h2 className="pt-2 text-lg font-semibold">Children</h2>
        <p>{PRODUCT_NAME} is not for children under 13, and we do not knowingly collect their data.</p>

        <h2 className="pt-2 text-lg font-semibold">Changes</h2>
        <p>
          When we change this policy, we update the date at the top of this page. If a change materially
          affects how we use your data, we tell you in the app or by email before it takes effect.
        </p>

        <h2 className="pt-2 text-lg font-semibold">Contact</h2>
        <p>
          Questions, privacy requests, or deletion requests:{' '}
          <a className="underline" href={`mailto:${SUPPORT_EMAIL}`}>
            {SUPPORT_EMAIL}
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
