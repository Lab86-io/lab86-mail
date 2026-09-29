import { COMPANY_NAME, PRODUCT_NAME, SUPPORT_EMAIL } from '@/lib/hosted/plans';

export default function PrivacyPage() {
  return (
    <main className="min-h-dvh bg-[var(--color-bg)] px-5 py-10 text-[var(--color-text)]">
      <article className="mx-auto max-w-3xl space-y-5">
        <h1 className="text-2xl font-semibold">Privacy Policy</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          Effective June 2026. Updated September 29, 2026.
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
            bodies, snippets, labels, attachments, drafts, and outbound send metadata. It also keeps copies of
            the attachment files from the last 60 days of mail, so that they open quickly.
          </li>
          <li>
            <strong>Calendar, contact, and file data:</strong> the calendar events and contacts of a connected
            account, and files when you connect a file service such as Google Drive.
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
          To sort and search your mail and to do the work you ask for, {PRODUCT_NAME} sends relevant message
          content and your instructions to model providers. They return summaries, classifications, search
          vectors, drafts, and other results. Hosted requests go through OpenRouter. OpenRouter sends each
          request only to a model host that does not train models on the data. Some of these hosts keep
          requests for a limited time under their own policies, for example to find abuse.
        </p>
        <p>
          If you add your own OpenRouter key, the same rule applies. If you add your own OpenAI or Anthropic
          key, requests go directly to that provider under your agreement with it.
        </p>

        <h2 className="pt-2 text-lg font-semibold">Google user data</h2>
        <p>
          {PRODUCT_NAME}&apos;s use and transfer of information received from Google APIs adheres to the{' '}
          <a className="underline" href="https://developers.google.com/terms/api-services-user-data-policy">
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements. When you connect a Google account, {PRODUCT_NAME} uses the
          Gmail access you grant to read, sort, label, draft, and send mail for you, and uses your Google
          email address to identify the connected account. It uses the Google Calendar access to show, create,
          and change your events, and the contacts access to show names and suggest recipients. If you connect
          Google Drive, {PRODUCT_NAME} uses that access to find, open, and create the files you ask for.
        </p>
        <p>
          A Google account can connect directly to Google. Then {PRODUCT_NAME} uses the Google APIs for the
          mail, calendar, and contacts of that account. A Google account that connected through Nylas stays on
          Nylas until you connect it again. Microsoft and iCloud accounts connect through Nylas.
        </p>
        <p>
          We do not sell Google user data, use it for advertising, use it to train generalized artificial
          intelligence or machine learning models, or allow humans to read message content except with your
          consent, for security, to comply with law, or for support you request.
        </p>
        <p>
          We transfer Google user data to the service providers in &quot;How we share data&quot; only to give
          you the features that you use, for security, or to obey the law.
        </p>

        <h2 className="pt-2 text-lg font-semibold">How we share data</h2>
        <p>
          {PRODUCT_NAME} does not sell personal information. We use service providers to run the product:
          Railway, Convex, Nylas, Clerk, Stripe, Resend, and OpenRouter. OpenRouter sends model requests only
          to hosts that do not train models on the data. Examples are OpenAI, Anthropic, Amazon Web Services,
          Microsoft Azure, and Google Cloud. If you add your own model key, we also send requests to the
          provider of that key.
        </p>
        <p>Some features also send data to these services:</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong>Browserbase:</strong> runs the web browser for web search, for the web pages that you or
            the assistant open, for guided work, and for slide images. It receives the search words, the page
            addresses, and the slide content. It records the browser sessions of guided work.
          </li>
          <li>
            <strong>Apple Push Notification service:</strong> receives the device token of your iPhone, iPad,
            or Mac and the text of each notification that you turn on, for example the sender and subject of
            new mail.
          </li>
          <li>
            <strong>Browser push services:</strong> browser notifications go through the push service of your
            browser, for example Google, Mozilla, or Apple. They are encrypted and hold only fixed text, such
            as a check-in reminder.
          </li>
          <li>
            <strong>DuckDuckGo and Google site icons:</strong> to show the logo of a company sender or a web
            site, we ask these icon services for the icon of that domain. Your browser sends some of these
            requests, so the service also receives your IP address. We do not send personal mail domains such
            as gmail.com.
          </li>
          <li>
            <strong>Open-Meteo:</strong> for the weather in your brief, receives the location that you share
            from your device, or up to three place names from your calendar events, or the city of your time
            zone.
          </li>
          <li>
            <strong>OpenStreetMap Nominatim:</strong> when a plan needs places near you and your device shares
            its location, receives that latitude and longitude and returns the name of the city and region.
          </li>
          <li>
            <strong>Google Maps:</strong> when you open an event that has a place, your browser shows a map of
            that place from Google Maps. Google receives the place text and your IP address.
          </li>
          <li>
            <strong>Connected tools:</strong> if you connect GitHub, Bitbucket, Jira, Slack, or Granola, we
            send your requests to that service and read the results for you, with the access that you give.
          </li>
        </ul>
        <p>
          Your browser also loads some content directly from other hosts. These hosts receive your IP address.
          The fonts of some pages come from Google Fonts. The art in your brief comes from public museum
          collections. A social post with no author picture gets a generated picture from DiceBear, which
          receives the author name. Images in a message come from the servers that the sender chose, as in
          other mail apps.
        </p>
        <p>
          These providers process data only to provide, secure, bill, or support {PRODUCT_NAME}. We may also
          disclose data when the law requires it or to protect users and the service from fraud or abuse.
        </p>

        <h2 className="pt-2 text-lg font-semibold">Security</h2>
        <p>
          Data moves between your device, {PRODUCT_NAME}, and our service providers over encrypted (TLS)
          connections. Convex stores the data, including the attachment copies, encrypted at rest. Model
          provider keys that you add are encrypted before we store them. Access to production systems is
          limited to the people who operate the service.
        </p>

        <h2 className="pt-2 text-lg font-semibold">Retention and deletion</h2>
        <p>
          We keep your data while your account is active. When you disconnect a mailbox, we revoke our access
          to it and delete its {COMPANY_NAME}-hosted grant records. Then we delete its stored mail, labels,
          calendar events, contacts, attachment copies, search index, and sync state. We also delete its
          provider webhook records and what we made from its mail: memory notes, Work receipts, notifications,
          event suggestions, and prepared brief items. If another connection in {PRODUCT_NAME} uses the same
          Google sign-in, for example your Google Drive connection, we delete our copy of the access but do
          not revoke the sign-in, so that the other connection keeps working.
        </p>
        <p>
          If a mailbox needs a reconnect for 30 days, a daily job deletes the same mailbox data. It keeps the
          mailbox entry and its grant record, so that you can reconnect or disconnect the mailbox in Settings.
          Some items stay until you delete them or your account. These are tasks and Work that you made from a
          message, notes about an area, the activity log, and past briefs.
        </p>
        <p>
          We delete provider webhook records after 14 days, or after 30 days if we could not process them.
          Account deletion removes your {COMPANY_NAME}-hosted account data, model settings, usage records,
          index data, attachment copies, and connected mail grants. These actions do not delete messages from
          the original mail provider mailbox unless you separately perform a delete action in that provider.
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
