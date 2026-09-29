# Xcode Cloud and TestFlight

Production is the only hosted backend. Follow the shared
[release runbook](../hosted-release-runbook.md); feature PRs target `main` and
pass CI plus CodeRabbit before merge.

The `Xcode Cloud production trigger` GitHub workflow consumes the successful
`Deploy Production` run's immutable release artifact, resolves its version tag
and commit, starts the `Production App Store` Xcode Cloud workflow, verifies the
signed export, and uploads it to TestFlight. Its manual dispatch input is a
successful production deployment run ID. There is no staging distribution workflow.

Every distributed iOS/macOS build uses `https://mail.lab86.io`, production Convex
`https://proficient-viper-594.convex.cloud`, and Clerk `clerk.mail.lab86.io`.
Xcode Cloud's post-clone script generates the project and embedded configuration;
retain its production assertions and signed-export checks.

Native acceptance on PRs builds iOS and macOS without signing or distribution.
Local development and test configurations remain separate from distributed builds.
Apple Developer team `5JZV7V6Y4Z`, production signing, APNs, and TestFlight groups
remain in use. Old staging references accepted by historical build scripts are
compatibility paths, not instructions to provision another hosted environment.
