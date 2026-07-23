# Albatross native mobile plan

Date: 2026-07-15

Albatross is a native iOS 27 mail client, not a companion, WebView, PWA, or staged mock of the web
product. The product bar is that it can replace Mail on the user's phone while making proactive work
feel more useful than interruptive.

This is not a waterfall roadmap. Every change travels through one complete product loop:

```text
provider event -> durable Lab86 state -> policy/dedupe -> APNs -> native route/action
       ^                                                        |
       +-------------- existing authenticated tools <-----------+
```

The app, server boundary, durable state, notification policy, Siri surface, offline behavior, and
tests evolve together. A capability is only considered present when that whole loop works.

## Current integrated baseline

- Native SwiftUI application in `apps/ios`, generated reproducibly with XcodeGen and built with the
  Xcode 27 SDK.
- Clerk authentication, Clerk bearer tokens for the existing Next.js API, and Clerk/Convex wiring.
- A Clerk/Apple associated-domain release check that verifies the signed application identifier at
  both the instance AASA endpoint and Apple's associated-domains CDN.
- Today, Mail, Calendar, Tasks, Work, Activity, Assistant, Compose, and Settings use the existing
  product data and tool contracts rather than fixture data.
- Unified, account-scoped, and smart-category mail with live Convex inbox/thread updates; privacy-
  sandboxed rich HTML, readable MIME/plaintext fallback, protected Quick Look attachment previews,
  search, compose, reply, reply-all, forward, CC/BCC, archive, trash, optimistic read/unread and
  star/unstar, scheduled-send backend support, pull-to-refresh, and `mailto:` prefilling.
- Per-user protected offline snapshots, background refresh, universal/deep-link routing, and secure
  cache/token cleanup at sign-out.
- Direct APNs device registration, rotation, revocation, invalid-token expiry, delivery attempts,
  foreground presentation, and cold-start routes.
- Durable new-mail, email-to-calendar, approval, and evening check-in notification loops. New-mail
  notifications expose Reply, Mark Read, and Archive actions. Calendar suggestions retain the human
  accept/dismiss boundary and never mutate a calendar from detection alone.
- Account-level controls for all native notifications, ordinary new mail, calendar suggestions, and
  evening check-ins.
- Foundation Models summaries on eligible devices with the existing server model path as fallback.
- Complete iOS 27 `.mail` App Schema coverage for Siri and Apple Intelligence: create, update, save,
  open, delete, send, and schedule drafts; open, reply, reply-all, forward, update, archive, and
  delete mail. Xcode's App Intents metadata validator accepts the complete group.
- Private, fully protected Spotlight indexing for recent mail subjects and senders, with native
  thread deep links, account-scoped replacement, and recursive deletion at sign-out.

## Architecture boundaries

- The phone never receives Nylas credentials or server secrets. Mail mutations use
  `/api/tools/<name>` or the authenticated multipart `/api/compose` boundary.
- Convex is the durable source of truth for notifications, suggestions, devices, check-ins, and
  delivery status. APNs is a delivery adapter.
- Push custom data contains opaque entity identifiers and a validated route, not message bodies or
  provider credentials. Visible alert text is the only mail preview delivered to APNs.
- Model-produced calendar candidates are validation inputs. The user remains the authority for
  calendar writes, sends, deletes, invitations, and other human-facing effects.
- Device caches use per-Clerk-user filenames, iOS data protection, and backup exclusion. Sign-out
  revokes push before destroying the authenticated session.

## Continuous build order

Work proceeds by closing the highest-risk real-use loop, then running the same loop under more
conditions—not by shipping disconnected layers:

1. Exercise real connected mailboxes on a signed physical build: receive, open, act, reply, attach,
   schedule, kill the app, reconnect, and repeat across foreground/background/cold-start states.
2. Feed failures back into the shared server/tool contracts and focused tests so web and native
   behavior cannot diverge.
3. Tune notification policy from actual usage: account/thread controls, iOS Focus behavior, preview
   privacy, batching, and urgency. Preserve durable in-app state even when a delivery is suppressed.
4. Expand on-device intelligence only where it is private, bounded, and independently verifiable;
   keep connected-source reasoning and large-context planning on Lab86's server models.
5. Add the iOS share extension, Spotlight indexing/donation, widgets/controls where they shorten a
   complete workflow, and accessibility/performance budgets around the same production data.
6. Request Apple's managed default-mail entitlement once the production binary and support/privacy
   metadata meet Apple's requirements, then validate default-client selection and every `mailto:`
   entry path.
7. Distribute through TestFlight, add crash/performance telemetry with a documented privacy budget,
   and promote only builds that pass server tests, Swift tests, UI tests, App Intents extraction, and
   physical notification smoke tests.

## Release gates that require external state

- Xcode must be signed into Apple Developer team `5JZV7V6Y4Z` and have a development provisioning
  profile for `io.lab86.mail`; a certificate alone cannot install the app.
- A physical iPhone must be connected or reachable to validate APNs tokens, background delivery,
  notification actions, Foundation Models availability, and device-only performance.
- Production APNs key material must be configured through `APNS_KEY_ID`, `APNS_TEAM_ID`,
  `APNS_PRIVATE_KEY`, and `APNS_BUNDLE_ID` on the server.
- `com.apple.developer.mail-client` is a managed entitlement. Do not add it to signing entitlements
  until Apple grants it.

## iOS 27 grounding

- Mail App Schema and its all-schemas group requirement:
  <https://developer.apple.com/documentation/appintents/app-schema-domain-mail>
- App Intents and Apple Intelligence discoverability:
  <https://developer.apple.com/documentation/appintents/making-actions-and-content-discoverable-by-apple-intelligence>
- Foundation Models:
  <https://developer.apple.com/documentation/foundationmodels>
- User Notifications:
  <https://developer.apple.com/documentation/usernotifications>
- Background Tasks:
  <https://developer.apple.com/documentation/backgroundtasks>
- Default mail entitlement:
  <https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.mail-client>
