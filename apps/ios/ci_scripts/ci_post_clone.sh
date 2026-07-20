#!/bin/zsh
# Xcode Cloud post-clone: the .xcodeproj is generated, not committed, so CI
# must produce it, and Local.xcconfig (gitignored) must be synthesized from
# Xcode Cloud environment variables:
#   LAB86_API_BASE_URL, CLERK_PUBLISHABLE_KEY, CONVEX_DEPLOYMENT_URL,
#   CLERK_FRONTEND_API_HOST
# Set those in App Store Connect → Xcode Cloud → workflow → Environment.
set -euo pipefail

cd "$CI_PRIMARY_REPOSITORY_PATH/apps/ios"

brew install xcodegen

# Package macros (Equatable via SwiftStreamingMarkdown) need fingerprint
# validation skipped in non-interactive builds.
defaults write com.apple.dt.Xcode IDESkipMacroFingerprintValidation -bool YES

# Xcode Cloud accepts ordinary URL values, but xcconfig treats // as the start
# of a comment. Escape the scheme separator only when writing Local.xcconfig.
xcconfig_url() {
  printf '%s' "$1" | sed 's#://#:/\$()/#'
}

api_base_url="$(xcconfig_url "${LAB86_API_BASE_URL:?missing LAB86_API_BASE_URL}")"
convex_deployment_url="$(xcconfig_url "${CONVEX_DEPLOYMENT_URL:?missing CONVEX_DEPLOYMENT_URL}")"

cat > Config/Local.xcconfig <<EOF
LAB86_API_BASE_URL = ${api_base_url}
CLERK_PUBLISHABLE_KEY = ${CLERK_PUBLISHABLE_KEY:?missing CLERK_PUBLISHABLE_KEY}
CONVEX_DEPLOYMENT_URL = ${convex_deployment_url}
CLERK_FRONTEND_API_HOST = ${CLERK_FRONTEND_API_HOST:?missing CLERK_FRONTEND_API_HOST}
EOF

xcodegen generate
