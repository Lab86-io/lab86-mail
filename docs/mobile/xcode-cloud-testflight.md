# Xcode Cloud → TestFlight for the iOS app

Goal: every push to the chosen branch produces a TestFlight build — no more
Mac-side installs. The repo side is ready: `apps/ios/ci_scripts/ci_post_clone.sh`
installs XcodeGen, synthesizes `Config/Local.xcconfig` from workflow environment
variables, and generates `Lab86Mail.xcodeproj` before Xcode Cloud builds.

One-time setup (human-gated — needs the Apple Developer account, team 5JZV7V6Y4Z):

1. **App record.** App Store Connect → Apps → New App → bundle id `io.lab86.mail`
   (register the identifier in the developer portal first if it isn't), name
   "Albatross", platform iOS.
2. **Enable Xcode Cloud.** Open the generated `Lab86Mail.xcodeproj` in Xcode on
   the Mac → Product → Xcode Cloud → Create Workflow. Sign in, grant Xcode Cloud
   access to the GitHub repo (`Lab86-io/lab86-mail`) when prompted — this is the
   main permission/keys step.
3. **Workflow settings.**
   - Start condition: branch changes on `staging` (or a dedicated `mobile` branch),
     with "Files and folders" condition `apps/ios/**` so web-only pushes don't burn
     build hours.
   - Environment variables (plain, not secret, except the Clerk key can be secret):
     `LAB86_API_BASE_URL=https://mail-staging.lab86.io`,
     `CLERK_PUBLISHABLE_KEY=<pk_test…>`,
     `CONVEX_DEPLOYMENT_URL=<https://precise-skunk-847.convex.cloud>`,
     `CLERK_FRONTEND_API_HOST=<dev instance host>`.
   - Archive action: platform iOS, scheme `Lab86Mail`, deployment preparation
     "TestFlight (Internal Testing Only)" to start.
   - Post-actions: TestFlight internal group (create "Jakob" group with your
     Apple ID as tester).
4. **Signing.** Xcode Cloud manages certificates/profiles automatically (cloud
   signing) — no local certificate export needed. The app's entitlements (push,
   App Groups if any) must exist on the registered identifier.
5. **Push notifications caveat.** TestFlight builds use the production APNs
   environment. `lib/notifications/apns.ts` currently targets the sandbox for
   Debug device builds — confirm the server sends to production APNs for
   TestFlight installs (token-based auth works for both; the endpoint differs).
6. First green build → TestFlight app appears on the phone; installs update
   with a tap thereafter.

Later, for production: duplicate the workflow with `LAB86_API_BASE_URL=
https://mail.lab86.io` + prod Clerk/Convex values, External Testing (needs the
beta review), then App Store release once the product is deemed functional.
