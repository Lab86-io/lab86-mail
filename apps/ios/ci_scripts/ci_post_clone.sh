#!/bin/zsh
# Xcode Cloud post-clone: the .xcodeproj is generated, not committed, so CI
# must produce it, and Local.xcconfig (gitignored) must be synthesized for the
# staging TestFlight build. A separate production workflow must set
# LAB86_BUILD_CHANNEL=production and every production value explicitly.
# Xcode Cloud environment variables may override:
#   LAB86_API_BASE_URL, CLERK_PUBLISHABLE_KEY, CONVEX_DEPLOYMENT_URL,
#   CLERK_FRONTEND_API_HOST, LAB86_BUILD_CHANNEL
set -euo pipefail

cd "$CI_PRIMARY_REPOSITORY_PATH/apps/ios"

brew install xcodegen

# Package macros (Equatable via SwiftStreamingMarkdown) need fingerprint
# validation skipped in non-interactive builds.
defaults write com.apple.dt.Xcode IDESkipMacroFingerprintValidation -bool YES
# Swift OpenAPI Generator is a package build-tool plugin and requires its
# separate trust switch when Xcode Cloud cannot present an approval prompt.
defaults write com.apple.dt.Xcode IDESkipPackagePluginFingerprintValidatation -bool YES

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

build_channel="$(normalize_cloud_value "${LAB86_BUILD_CHANNEL:-staging}")"
case "$build_channel" in
  staging)
    # Staging is a named release environment, not a caller-selectable endpoint.
    # Keep its public configuration canonical even if stale workflow variables
    # remain in Xcode Cloud.
    api_input="https://mail-staging.lab86.io"
    convex_input="https://precise-skunk-847.convex.cloud"
    clerk_host="together-sawfish-53.clerk.accounts.dev"
    default_clerk_key="pk_test_$(printf '%s$' "$clerk_host" | base64 | tr -d '\n')"
    clerk_key="$default_clerk_key"
    ;;
  production)
    if [[ -z "${LAB86_API_BASE_URL:-}" || -z "${CONVEX_DEPLOYMENT_URL:-}" \
      || -z "${CLERK_FRONTEND_API_HOST:-}" || -z "${CLERK_PUBLISHABLE_KEY:-}" ]]; then
      echo "Production Xcode Cloud configuration requires API, Convex, and Clerk values." >&2
      exit 1
    fi
    api_input="$(normalize_cloud_value "$LAB86_API_BASE_URL")"
    convex_input="$(normalize_cloud_value "$CONVEX_DEPLOYMENT_URL")"
    clerk_host="$(normalize_cloud_value "$CLERK_FRONTEND_API_HOST")"
    clerk_key="$(normalize_cloud_value "$CLERK_PUBLISHABLE_KEY")"
    if [[ "$api_input" != "https://mail.lab86.io" ]]; then
      echo "Production iOS builds must target https://mail.lab86.io." >&2
      exit 1
    fi
    if [[ "$clerk_key" != pk_live_* ]]; then
      echo "Production iOS builds require a live Clerk publishable key." >&2
      exit 1
    fi
    if [[ "$convex_input" != https://*.convex.cloud || "$convex_input" == *precise-skunk-847* ]]; then
      echo "Production iOS builds require the production Convex deployment." >&2
      exit 1
    fi
    ;;
  *)
    echo "Unsupported LAB86_BUILD_CHANNEL: ${build_channel}" >&2
    exit 1
    ;;
esac

api_base_url="$(xcconfig_url "$api_input")"
convex_deployment_url="$(xcconfig_url "$convex_input")"

cat > Config/Local.xcconfig <<EOF
LAB86_INFO_API_BASE_URL = ${api_base_url}
LAB86_INFO_CLERK_PUBLISHABLE_KEY = ${clerk_key}
LAB86_INFO_CONVEX_DEPLOYMENT_URL = ${convex_deployment_url}
LAB86_INFO_CLERK_FRONTEND_API_HOST = ${clerk_host}
EOF

xcodegen generate
