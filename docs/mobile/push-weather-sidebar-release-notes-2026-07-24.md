# Push, Daily Alignment, Weather, and Sidebar Release Notes

Date: 2026-07-24

## Product intent

This release closes the daily Albatross loop:

1. At the configured evening check-in time, Albatross creates two distinct,
   replyable notifications:
   - “What did you get done today?”
   - “What do you want to get done tomorrow?”
2. A user can type or dictate either answer from the iOS notification without
   foregrounding the app.
3. The reflection reconciles only explicitly completed source items. The
   tomorrow answer becomes an intent overlay for the next SBAR index.
4. Matching source-grounded handoffs move upward without deleting protected
   handoffs or inventing evidence.
5. The 07:00 local-time Daily Brief incorporates that alignment and local
   weather. Its ready notification is queued only after the finished report is
   persisted.

## Native interaction research

Apple’s text-input notification action is the native mechanism for replying
from a notification:
[UNTextInputNotificationAction](https://developer.apple.com/documentation/usernotifications/untextinputnotificationaction).
The implementation keeps the action out of foreground mode and submits the
reply through an authenticated, rate-limited endpoint. The server derives the
prompt kind from the durable user-owned notification instead of trusting the
client.

The sidebar’s direct scrub is shaped like a restrained system wheel: the
selected item stays face-on while adjacent items rotate away on the x-axis.
The motion is removed when Reduce Motion is enabled, following Apple’s
[Accessibility guidance](https://developer.apple.com/design/human-interface-guidelines/accessibility).
Apple’s [Picker guidance](https://developer.apple.com/design/human-interface-guidelines/pickers)
informed the centered selection and cylindrical depth treatment.

Mobbin references reviewed before implementation:

- Wheel/depth patterns:
  [Google Photos](https://mobbin.com/screens/cc5f9d99-82ec-49d0-9a49-543f14e6be03),
  [Breathwrk](https://mobbin.com/screens/95295dfb-6c73-4c4b-9947-b96225ac618e),
  [Lyft](https://mobbin.com/screens/390f1696-2b54-414b-8f2f-6cdee52446b2),
  [Moonlitt](https://mobbin.com/screens/ee8bdf2d-fe47-424d-8102-de682b6677cd),
  [Moonly](https://mobbin.com/screens/4a9dc585-1c1c-418c-a545-824a59f3d819), and
  [Workplace](https://mobbin.com/screens/d5499181-4a50-4881-86c6-207119936feb).
- Dense mobile navigation:
  [Slack](https://mobbin.com/screens/eb9f8f92-a1ae-4c03-a169-458a1089fe5f),
  [ClickUp](https://mobbin.com/screens/c6c7f577-dc92-45a5-97d0-adeae9f71b3b),
  [Clover](https://mobbin.com/screens/d5b19130-5f21-45b1-8f81-0e128529c9b2),
  [ElevenLabs](https://mobbin.com/screens/6e5b7a38-9fdf-410a-a075-04f2f423e98e),
  [Otter AI](https://mobbin.com/screens/8b36b887-55a2-4d90-9b3c-439ec4ca992e), and
  [Expensify](https://mobbin.com/screens/19337c43-fbf4-4c73-b200-0ba93b712837).

The resulting sidebar preserves the existing density and row components. It
removes the five-Area cap, keeps every Area as an accessible Button, and
programmatically advances a non-user-scrollable viewport when the scrub enters
an edge band.

## WeatherKit integration

The iOS settings screen requires an explicit tap before storing an approximate
location. Disabling the feature removes the stored coordinates. The scheduled
server process uses Apple Weather when its WeatherKit Service ID is configured
and falls back to the existing forecast source if WeatherKit is unavailable,
so a provider outage cannot block a brief.

The implementation follows Apple’s
[WeatherKit REST authentication](https://developer.apple.com/documentation/WeatherKitRESTAPI/request-authentication-for-weatherkit-rest-api)
and
[weather endpoint](https://developer.apple.com/documentation/weatherkitrestapi/get-api-v1-weather-_language_-_latitude_-_longitude_)
contracts. Apple Weather output carries a visible attribution link per
[Weather attribution requirements](https://developer.apple.com/documentation/weatherkit/weatherattribution).

The Apple key has WeatherKit capability, but REST authentication also requires
a separately registered WeatherKit Service ID in the JWT `sub` claim. The
production variable `WEATHERKIT_SERVICE_ID` must be set to that exact identifier
after it is created or confirmed in Apple Developer. The APNs service does not
depend on this value.

## Credential and release boundaries

- The APNs signing key is stored only in Railway’s production environment.
- The private key is intentionally not embedded in the repository, Info.plist,
  xcconfig, app binary, or Xcode Cloud variables.
- The Release build contains the production `aps-environment` entitlement and
  bundle identifier `io.lab86.mail`; the server signs APNs requests for that
  topic.
- No credential values are included in these notes or the PR.

## Acceptance coverage

- APNs payload categories, routes, prompt kinds, environments, and failures.
- Two-prompt creation, deduplication, prompt-specific answers, and completion
  after both answers.
- Authenticated inline-response ownership and client-hint tampering.
- Morning brief preference and one-per-day ready-notification behavior.
- Explicit location validation, persistence, removal, and server consumption.
- WeatherKit JWT claims, normalization, attribution, and fallback behavior.
- Intent-driven stable SBAR ordering and brief prompt propagation.
- Full-Area sidebar edge advancement, wheel transforms, and Reduce Motion.
