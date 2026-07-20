#!/bin/zsh
# Xcode Cloud post-clone: the .xcodeproj is generated, not committed, so CI
# must produce it, and Local.xcconfig (gitignored) must be synthesized for the
# staging TestFlight build. Xcode Cloud environment variables may override:
#   LAB86_API_BASE_URL, CLERK_PUBLISHABLE_KEY, CONVEX_DEPLOYMENT_URL,
#   CLERK_FRONTEND_API_HOST
set -euo pipefail

cd "$CI_PRIMARY_REPOSITORY_PATH/apps/ios"

brew install xcodegen

# Package macros (Equatable via SwiftStreamingMarkdown) need fingerprint
# validation skipped in non-interactive builds.
defaults write com.apple.dt.Xcode IDESkipMacroFingerprintValidation -bool YES

# Xcode Cloud's editor may retain Markdown backticks pasted around a value.
# Remove those wrappers so either the existing values or no values work.
normalize_cloud_value() {
  printf '%s' "$1" | tr -d '`\r\n'
}

# xcconfig treats // as the start of a comment. Escape the scheme separator
# only when writing Local.xcconfig; already escaped values remain unchanged.
xcconfig_url() {
  printf '%s' "$1" | sed 's#://#:/\$()/#'
}

api_input="$(normalize_cloud_value "${LAB86_API_BASE_URL:-https://mail-staging.lab86.io}")"
convex_input="$(normalize_cloud_value "${CONVEX_DEPLOYMENT_URL:-https://precise-skunk-847.convex.cloud}")"
clerk_host="$(normalize_cloud_value "${CLERK_FRONTEND_API_HOST:-together-sawfish-53.clerk.accounts.dev}")"
default_clerk_key="pk_test_$(printf '%s$' "$clerk_host" | base64 | tr -d '\n')"
clerk_key="$(normalize_cloud_value "${CLERK_PUBLISHABLE_KEY:-$default_clerk_key}")"

api_base_url="$(xcconfig_url "$api_input")"
convex_deployment_url="$(xcconfig_url "$convex_input")"

cat > Config/Local.xcconfig <<EOF
LAB86_API_BASE_URL = ${api_base_url}
CLERK_PUBLISHABLE_KEY = ${clerk_key}
CONVEX_DEPLOYMENT_URL = ${convex_deployment_url}
CLERK_FRONTEND_API_HOST = ${clerk_host}
EOF

xcodegen generate
