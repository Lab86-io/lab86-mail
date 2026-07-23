# Authenticated shell and provider onboarding research

Date: 2026-07-17

Status: research gate complete; visual implementation not started.

This slice covers the root authenticated shell, optional first-account setup,
per-account service state, and the transition into a useful Today or Mail
destination. It does not cover provider-specific credential forms in depth.

## Implementation status

This research now feeds the native whole-app plan directly. Codex owns the UI
research, design, implementation, integration, tests, rendered review, and
physical-device validation. There is no model handoff or Opus implementation
gate; implementation proceeds in scheduled slices against the acceptance criteria
and state matrix below.

## Apple research

Browserbase was used against the current pages on 2026-07-17.

- [What's new in SwiftUI](https://developer.apple.com/videos/play/wwdc2026/269/)
  organizes the current material around refreshed look and feel, presentation
  and interaction, and data flow and performance. For this slice, system
  navigation and controls remain the structural baseline.
- [Communicate your brand identity on iOS](https://developer.apple.com/videos/play/wwdc2026/251/)
  frames brand as a balance between familiar system behavior and distinctive
  typography, color, content, iconography, and interaction. Albatross identity
  belongs in content and restrained accents, not a replacement navigation
  system or content-wide glass cards.
- [Onboarding](https://developer.apple.com/design/human-interface-guidelines/onboarding)
  says onboarding should be fast and optional, happen after launch, teach
  interactively, keep prerequisite flows brief, postpone nonessential setup,
  provide useful defaults, and request private access either where it is
  required or when the related feature is first used.
- [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)
  requires an interface that is intuitive, perceivable, and adaptable. The
  flow must support larger text, VoiceOver descriptions, system colors and
  contrast, non-color state indicators, sufficiently sized and spaced controls,
  simple interactions with alternatives, and Reduce Motion.
- [Notifications](https://developer.apple.com/design/human-interface-guidelines/notifications)
  describes notifications as timely, high-value information. It favors concise
  content, deduplication, foreground updates that are discoverable but not
  distracting, privacy-safe previews, and short actions that save a trip into
  the app. Errors belong in app alerts or inline state, not notifications.
- [ASWebAuthenticationSession](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession)
  is the system OAuth surface. The session returns through a callback URL,
  requires a presentation context, supports user cancellation, and uses the
  system web authentication experience rather than an embedded credential form.

Apple conclusions:

1. Today remains the cold-launch default; onboarding is an authenticated task,
   not a branded launch gate.
2. Provider connection is skippable. Skipping leaves a persistent setup action
   in Today instead of trapping the user.
3. OAuth consent remains provider-owned inside `ASWebAuthenticationSession`.
   Native screens explain why access is useful before starting that session.
4. Notification authorization follows a concrete benefit explanation and can
   be deferred. Denial never blocks account use.
5. Healthy cached domains remain usable during a provider or network failure.

## Current Albatross behavior

Browserbase inspection found:

- `https://mail.lab86.io` currently presents the Clerk-hosted Lab86 Mail sign-in
  experience with Google, identifier, passkey, and sign-up actions.
- `https://mail-staging.lab86.io` returned only `Authentication required.`, so an
  authenticated desktop journey could not be inspected in that session.
- The visible production sign-in describes Gmail, Outlook, and iCloud, but does
  not expose the signed-in provider setup or recovery behavior before auth.

Repository inspection fills in the authenticated ownership semantics without
claiming unavailable rendered behavior:

- The iOS shell currently branches directly on Clerk state in
  `apps/ios/Lab86Mail/Features/Shell/RootView.swift`.
- The five native destinations and Today default live in
  `apps/ios/Lab86Mail/Features/Shell/AppShellView.swift`.
- Account setup and service state must come from `MobileContractV1` bootstrap,
  the typed account repository, and SwiftData cache rather than desktop-only
  session state.

## Mobbin queries and screens examined

The references are patterns to synthesize, not screens to copy.

### Complete journeys

Query: `Spark Mail onboarding with email provider selection, provider consent,
notification explanation, initial sync progress, and arrival in inbox`

- [Spark Mail — Onboarding](https://mobbin.com/flows/61018471-6aa1-4d28-aac4-c1735c2909c8),
  especially positions 1, 6, 11, 16, and 21: brand arrival, account entry,
  provider-owned consent, a monetization interruption, and arrival in a useful
  inbox.
- [Spark Mail — Logging in](https://mobbin.com/flows/98d7f0a3-ed0a-4335-9c58-1b1fbb880c73),
  especially positions 1, 4, 7, and 10: direct credential start, system web
  authentication, immediate mailbox context, and visible undo feedback.

Query: `Amie enabling email for an existing account with per-account mail
service controls and ability to revoke or disconnect`

- [Amie — Enabling email](https://mobbin.com/flows/f2989f5d-0019-40ba-b64e-a23d7b723b02),
  positions 1, 5, and 8: account-level Calendar/Email controls, provider-owned
  account choice, and return to visibly updated service state.
- [Amie — Accounts](https://mobbin.com/flows/c4ffc2da-4d50-41d2-b893-2e1b9b25bce4):
  settings-to-account navigation and clear logout placement.
- [Amie — Adding an account](https://mobbin.com/flows/dae87480-af1a-466e-9082-c450182ad5e6):
  multiple accounts remain separately legible, with connected status and
  per-account controls.

### Individual states

Query: `email or productivity app pre-permission screen explaining a concrete
notification benefit with allow and not now actions`

- [Attio notification explanation](https://mobbin.com/screens/3ecd678d-fe98-4a2c-bc0b-5e6694796bab)
  pairs the benefit with explicit Allow and Not now actions.
- [Apple TV notification explanation](https://mobbin.com/screens/298bd3c0-f834-468b-85b8-53a29ba12dea)
  names concrete content categories before the system prompt.
- [Amie notification explanation](https://mobbin.com/screens/acd12bae-61fe-45ce-a339-2b50f218bbc1)
  scopes notifications to events but visually previews the system alert.
- [Venmo notification explanation](https://mobbin.com/screens/f38f4f9d-6727-4164-a1f3-acc5224e48a7)
  explains value and reversibility in Settings without blocking progress.

Query: `email app account settings screen showing disconnected email account,
sync error, reconnect action, and healthy accounts remaining visible`

- [Amie connected accounts](https://mobbin.com/screens/3fe0bffd-e60d-4d0a-9cd9-6537c4221b07)
  keeps multiple accounts and per-service states independently readable.
- [Fabric connection failure](https://mobbin.com/screens/0118165d-635d-4fa8-bcae-48836025fdcc)
  gives a specific retry path after OAuth failure.
- [Arc Sidebar Sync recovery](https://mobbin.com/screens/cbda8195-20b9-4a65-abba-28471e93b871)
  combines preparation guidance, Learn more, and Check again.
- [Fetch disconnect confirmation](https://mobbin.com/screens/2af59f1a-5749-440b-92d3-bd9fc096a967)
  confirms a destructive disconnect in context.

## Recurring patterns to adopt

- One primary decision per screen, with Back/Cancel and Skip/Not now where the
  step is optional.
- Provider identity and email remain visible after connection, while service
  capabilities and sync health appear beneath the account.
- OAuth happens in the provider/system surface; the app owns the explanation,
  transition, cancellation recovery, and resulting account state.
- A successful connection returns to a useful product destination instead of a
  celebratory dead end.
- Connection failure offers a specific recovery action and retains any healthy
  connected accounts.
- Destructive disconnect is explicit and scoped to the selected account.

## Rejected patterns

- Long branded splash sequences or tutorial carousels before sign-in.
- Spark's paywall interruption between account consent and first useful inbox.
- Rendering a fake system notification alert inside the pre-permission screen;
  it creates two stacked permission moments and can confuse VoiceOver users.
- Copying provider scope language into a custom consent screen. Provider consent
  stays provider-owned; Albatross explains product benefit and policy.
- A single global error that blanks every account when only one connection fails.
- Status conveyed only by green/red color, unlabeled toggles, or animation.
- Hiding service limitations behind controls that fail after tapping.
- Glass or elevated cards for every content group; system material remains
  concentrated in navigation, controls, and presentations.

## Navigation and data ownership

```text
Cold launch
  -> explicit push/Siri/Spotlight/universal-link route, if authenticated
  -> otherwise Today
  -> setup checklist when no provider is connected
       -> provider choice
       -> benefit and requested services
       -> system OAuth or provider-specific secure preparation
       -> initial sync status
       -> Today or Mail with setup progress still visible
```

- `SessionStore` owns configured, signed-out, authenticating, preparing,
  ready/degraded, and signing-out root state.
- `AccountStore` owns accounts, capabilities, connection state, backfill state,
  and domain-specific errors.
- `RouteCoordinator` owns the initial route; onboarding does not overwrite an
  explicit authenticated route.
- `SyncCoordinator` guarantees one account refresh per user.
- SwiftData account records provide immediate cached state. The versioned mobile
  bootstrap is authoritative for current capabilities and sync status.
- Clerk owns product authentication. Provider credentials and tokens are never
  placed in SwiftData or logs.

## Mutations and recovery

| Mutation | Confirmation boundary | Recovery |
|---|---|---|
| Start Google/Microsoft OAuth | User taps provider after benefit/scope explanation. | Cancellation returns to provider choice with existing accounts intact. |
| Connect iCloud | User explicitly starts app-password flow. | Preserve host-side session state; show preparation instructions and retry without persisting the password. |
| Connect IMAP/SMTP | User submits secure settings after discovery. | Show field-specific TLS/auth failure and retain only non-secret configuration. |
| Enable Mail/Calendar service | Server receipt confirms capability/scopes. | Display pending state; rollback toggle on failure and explain required scope. |
| Request notifications | User taps Allow notifications after benefit copy. | Denial becomes a nonblocking Settings state with Open Settings guidance. |
| Retry/resync | Explicit per-account action. | Healthy accounts and cached content remain usable. |
| Disconnect account | Destructive confirmation names the account and cleanup effect. | Show durable cleanup state; retry cleanup without reconnecting or affecting other accounts. |
| Sign out | Available from ready, loading, offline, degraded, and expired states. | Cancel work, purge the user's cache/routes/files/Spotlight, reset navigation, then end Clerk auth. |

## State matrix

| State | Root/shell behavior | Provider/account behavior | Accessibility contract |
|---|---|---|---|
| Loading | Use cached root/account state immediately; show bounded progress only where live data is pending. | Each account owns its own sync label and progress. | Progress has a descriptive label and does not rely on indefinite animation. |
| Empty | Today opens with a persistent, skippable setup checklist and still exposes non-mail product areas. | Provider list explains supported Gmail, Microsoft, iCloud, and IMAP/SMTP paths. | Heading, explanation, and primary action form a predictable reading order. |
| Populated | Today is selected unless an explicit typed route overrides it. | Healthy accounts show email, provider, services, last sync, and capability limitations. | Account/service group is a coherent VoiceOver group with status text. |
| Editing | Preserve system navigation and keyboard behavior; prevent duplicate submissions. | Provider-specific fields show validation beside the field and a visible Cancel action. | Large text reflows vertically; fields retain persistent labels and error associations. |
| Offline | Cached destinations remain navigable and clearly indicate offline freshness. | New OAuth/connect operations are unavailable with explanation; safe cached settings remain visible. | Offline state uses icon plus text, not color alone. |
| Partial failure | Do not show a global blocking alert for a domain-local failure. | The failing account shows Reconnect/Retry; healthy accounts and their content remain available. | Error and recovery action are adjacent in reading/focus order. |
| Permission denied | App remains usable; the relevant feature explains the limitation. | Notifications show Disabled in Settings and an Open Settings action; provider scope denial shows required service impact. | Never repeatedly trigger the system prompt; announce the state change. |
| Destructive confirmation | Use a system confirmation presentation scoped to the selected object. | Name the account, affected services, cleanup behavior, and whether provider-side data remains. | Destructive action is labeled, not positioned as the default, and supports keyboard/Switch Control. |
| Large Dynamic Type | Prefer vertical flow and scrolling; do not fix onboarding to one screen height. | Service rows wrap rather than truncate provider/account/status details. | Validate at accessibility sizes with no clipped primary or recovery actions. |
| VoiceOver | Focus begins at the screen heading and follows the visible task order. | Announce provider, email, connection state, each service state, progress, and recovery action without redundant icon names. | OAuth transition, cancellation, completion, and errors post meaningful state changes; decorative art is hidden. |

## Acceptance criteria for the direct Codex slice

1. Root state is explicit and deterministic across configuration, signed out,
   authenticating, cached preparation, ready, degraded, expired, and signing out.
2. Today is the default authenticated cold start; typed external routes override it.
3. Provider setup is skippable and no-provider users retain a useful shell plus
   a persistent setup checklist.
4. Gmail and Microsoft use `ASWebAuthenticationSession`; iCloud and IMAP paths
   explain secure preparation without persisting raw credentials.
5. Account rows use typed `AccountStore` data, expose capability differences and
   per-account sync/recovery, and never blank healthy accounts.
6. Notification benefit copy precedes the system request; denial is nonblocking.
7. Every state in the matrix has focused behavioral/state tests plus VoiceOver
   labels, Dynamic Type layout, dark mode, Increase Contrast, and Reduce Motion checks.
8. The rendered iPhone result is reviewed against the Apple and Mobbin references
   above, then installed and validated on the physical iPhone.

## Direct implementation rule

Codex implements the slice from this research, preserving Apple precedence,
desktop semantics, typed ownership, the full state matrix, and focused-test
requirements. Every material increment receives rendered iPhone review and a
physical-device build before acceptance.
