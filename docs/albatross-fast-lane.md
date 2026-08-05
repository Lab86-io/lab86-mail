# The Albatross fast lane

Five tiers, ordered by what each one depends on rather than by how fast it is.
Tiers 1 through 3 are pre-commit: they put a change on the phone without
touching git history. Tiers 4 and 5 are promotion.

The point of the arrangement is that refinement and release run at different
speeds. A batch of small UI corrections should not each cost a release cycle,
and a release should not be the only way to see a correction on a real device.

## Tier 1 — server surfaces, seconds, no build

`scripts/fastlane/dev-server.sh`

Serves the web app from lab86 over the tailnet at
`https://lab86.tail478321.ts.net:8449`. A fast-lane build pointed at that
address in Settings > Development > Server pulls every server-rendered surface
from it: brief documents, area detail, email HTML, the tool-UI layer, every API
response. Edit one, pull to refresh, done.

Defaults to the production environment, because a fast-lane build carries a
production Clerk session and only a server holding production credentials can
verify that token. That means this server reads and writes real data. Pass
`--env development` for a server that is safe to break, but note that the
fast-lane build's session will be rejected by it.

Use it for: anything rendered or decided on the server.

## Tier 2 — native UI, about a minute, no commit

`scripts/fastlane/fastlane-ios.sh`

Takes the working tree as it stands, committed or not, and produces a
dev-signed build on the phone:

1. rsync `apps/ios` to the Mac build box over the tailnet
2. xcodegen and an incremental `xcodebuild` archive, Debug configuration
3. export a dev-signed IPA
4. publish it under `https://files.jjalangtry.com/albatross-dev/`
5. tap the install link on the phone

A run with no source changes takes 37 seconds measured end to end; a real change
adds only its compile time, because DerivedData and the resolved packages stay
warm between runs. The first run after a macOS or Xcode update is cold and slow.

The build installs as **Albatross Dev**, bundle identifier `io.lab86.mail.dev`,
beside the TestFlight app rather than over it. Both can be open at once, which
is what makes before-and-after comparison possible.

Two things about how it runs are not obvious and should not be "simplified"
away:

- The build is started with `launchctl kickstart` as a launch agent in the
  console user's login session, not from the ssh session. codesign needs the
  private key in the login keychain, and a non-interactive ssh session cannot
  reach the Security agent to use it — it fails with `errSecInternalComponent`.
- Xcode 27 runs `AppIntentsSSUTraining` with `--archive-ssu-assets` on every
  build of a target declaring App Intents, and it fails at "Archiving all
  locales". The flag is unconditional; building instead of archiving does not
  avoid it and `APPINTENTS_DEPLOY_SSU_ARTIFACTS` does not suppress it. Because
  that failure aborts the build before CodeSign, `remote-build.sh` tolerates
  that one error and signs the bundle itself using the entitlements from the
  embedded profile. Any other error is still fatal, and the signature is
  verified before anything is published.

The build is dev-*signed* but production-*configured*: it talks to
`mail.lab86.io`, production Convex, and production Clerk. This is not a
convenience, it is the only channel the existing guardrails permit — see
"The invariant" below.

Use it for: anything native. New views, layout structure, animation,
interaction, design-system values.

The app embeds one extension, `Lab86MailAutoFill`, which supplies one-time
codes to system AutoFill. Two things about that are load-bearing for the fast
lane and are asserted by `release-invariants.test.mjs`:

- An extension identifier has to stay nested under its host app's, so the
  rename to `.dev` moves both or the bundle will not install.
- The hand-signing path signs each `.appex` against the entitlements in its own
  embedded profile. Signing it bare strips the app group, and the extension
  then loads normally and finds no codes — which reads as the feature being
  broken rather than as a signing fault. The signature check refuses to publish
  a build whose extension lost the group.

Known limits of a fast-lane build:

- Push notifications do not arrive. The server's APNs configuration is bound to
  `io.lab86.mail`, not the `.dev` identifier. Code AutoFill still works, because
  the app also refreshes codes on foreground; only the latency changes.
- The first build after adding an entitlement can fail provisioning until the
  App ID carries the capability. `-allowProvisioningUpdates` usually resolves
  this on its own, but an app group has to exist in the developer portal.
- Universal links and passkey autofill degrade, because the site association
  file does not list the `.dev` application identifier.
- The Mac must be awake and on the tailnet. A closed-lid MacBook on battery
  sleeps regardless of the caffeinate assertion the bootstrap installs.

## Tier 3 — hot reload, seconds, on top of a Tier 2 build

Requires a Tier 2 build already installed; it patches that running app rather
than replacing it. Scoped deliberately narrowly: edits inside a SwiftUI view's
`body` — spacing, colour, type, corner radius, the arrangement of an existing
subtree. Anything that changes a type, adds a stored property, or adds a file
needs a Tier 2 rebuild.

Use it for: the last mile of pixel tuning, where the round trip matters more
than the breadth of what can change.

## Tier 4 — staging

The batch is worth keeping. Commit it on the feature branch, push to `staging`,
and let CI take it: development deploy to Railway and CodeRabbit review. Two
review rounds, applying findings between them.

There is no Xcode Cloud staging build. Tier 2 replaced what it was for, and it
had been failing in `ci_post_clone` for weeks without anybody needing it. The
workflow is still there and still tested, runnable by hand when the question is
specifically whether a staging archive builds. The consequence is that native
code reaches its first real compile at Tier 5, so a native change is unverified
until the production build goes green — treat it that way.

## Tier 5 — production

Merge to `main`. The production workflow versions, tags, deploys, and Xcode
Cloud distributes to TestFlight.

## Versioning

The version is a judgement about what a batch did, so it is stated rather than
guessed. `scripts/release-version.mjs` resolves it in this order:

| Source | Example |
| --- | --- |
| `--set` | `--set 1.0.0` |
| `--bump` | `--bump minor` |
| `Release-As:` trailer in the promotion commit or PR body | `Release-As: 1.0.0` |
| `Release-Bump:` trailer | `Release-Bump: minor` |
| `[MAJOR]` / `[MINOR]` markers | `feat: areas [MINOR]` |
| default | patch |

At Tier 5, decide the level from what the batch actually contains and write the
trailer into the promotion commit. A version that does not advance the current
one is refused rather than silently accepted.

Fast-lane build numbers are minutes since the epoch: monotonic, so an install is
never a downgrade, and readable back as the moment the build was cut. Settings
shows the build number in Debug builds so the one in hand is identifiable.

## The invariant

Every distributed build talks to production. `ci_post_clone.sh` refuses to
configure any other channel, and `verify_built_configuration.sh` re-checks the
processed Info.plist as a post-build phase on every build, including fast-lane
ones.

The Tier 1 redirect does not weaken this. It lives inside `#if DEBUG`, returns
the bundled URL unconditionally in a Release build, and the screen that sets it
is not compiled into one. It also redirects the API host alone — Clerk and
Convex stay on production, which is exactly why a redirected build keeps its
session and its data. `scripts/fastlane/release-invariants.test.mjs` holds these
properties, because the Swift suite only ever runs in Debug and cannot.

## The build box is remote

The Mac is normally on a different network, reachable only over the tailnet.
That makes one failure mode dominant: **a sleeping Mac cannot be woken.**
Wake-on-LAN needs a peer on the same LAN, and Tailscale cannot supply one. If it
sleeps while you are away from it, Tier 2 is unavailable until you are physically
back at the machine.

So the Mac must not sleep at all:

```
sudo pmset -a disablesleep 1
```

This needs a password, so it cannot be done over ssh from here — run it once on
the Mac itself. It is the only setting that also survives closing the lid.
`bootstrap-mac.sh` installs a `caffeinate -dims` assertion as well, which holds
idle sleep on battery, but the lid still wins over any assertion.

`scripts/fastlane/fastlane-status.sh` answers "is the fast lane ready" before you
ask for a change: whether the Mac is online and whether the link is direct or
relayed, whether sleep is disabled, whether Xcode is present, and what was last
published. On a relayed link the build is unaffected but transfers are slower.

Both scripts wait up to five minutes for the Mac to appear rather than failing on
the first refused connection, since a laptop that has just woken takes a moment
to rejoin the tailnet. `LAB86_FASTLANE_WAIT=0` restores fail-fast.

## Setup

`scripts/fastlane/bootstrap-mac.sh` prepares the Mac build box and is safe to
re-run; a macOS update is the usual reason it needs running again.

The fast lane depends on: the Mac awake on the tailnet, the App Store Connect
key at `~/.config/lab86-private/asc/`, the device registered in App Store
Connect, and the Caddy route serving `/albatross-dev/` from `/srv/albatross-dev`
with an XML content type for the manifest, which is what iOS requires before it
will accept an over-the-air install.
