#!/bin/bash
set -euo pipefail

channel="${1:-}"
export_root="${2:-}"

if [[ "$channel" != "staging" && "$channel" != "production" ]]; then
  echo "Usage: verify-ios-export.sh <staging|production> <export-directory>" >&2
  exit 64
fi
if [[ ! -d "$export_root" ]]; then
  echo "iOS export directory does not exist: $export_root" >&2
  exit 66
fi

ipa_paths=()
while IFS= read -r -d '' candidate; do
  ipa_paths+=("$candidate")
done < <(find "$export_root" -type f -name '*.ipa' -print0)
if (( ${#ipa_paths[@]} == 0 )); then
  echo "The Xcode Cloud export did not contain an IPA." >&2
  exit 1
fi
if (( ${#ipa_paths[@]} != 1 )); then
  echo "The Xcode Cloud export contained multiple IPA files." >&2
  exit 1
fi
ipa_path="${ipa_paths[0]}"

inspection_root="$(mktemp -d)"
trap 'rm -rf "$inspection_root"' EXIT
unzip -q "$ipa_path" -d "$inspection_root"

app_path="$(find "$inspection_root/Payload" -maxdepth 1 -type d -name '*.app' -print -quit)"
if [[ -z "$app_path" ]]; then
  echo "The IPA did not contain an application bundle." >&2
  exit 1
fi

info="$app_path/Info.plist"
plist_value() {
  /usr/libexec/PlistBuddy -c "Print :$1" "$info"
}

bundle_id="$(plist_value CFBundleIdentifier)"
api_base_url="$(plist_value LAB86_API_BASE_URL)"
convex_url="$(plist_value CONVEX_DEPLOYMENT_URL)"
clerk_key="$(plist_value CLERK_PUBLISHABLE_KEY)"

[[ "$bundle_id" == "io.lab86.mail" ]] || {
  echo "Unexpected bundle identifier in signed IPA." >&2
  exit 1
}

case "$channel" in
  staging)
    [[ "$api_base_url" == "https://mail-staging.lab86.io" ]] || {
      echo "Staging IPA contains an invalid API base URL." >&2
      exit 1
    }
    [[ "$convex_url" == "https://precise-skunk-847.convex.cloud" ]] || {
      echo "Staging IPA contains an invalid Convex deployment." >&2
      exit 1
    }
    [[ "$clerk_key" == pk_test_* ]] || {
      echo "Staging IPA does not contain a Clerk test publishable key." >&2
      exit 1
    }
    expected_clerk_host="together-sawfish-53.clerk.accounts.dev"
    ;;
  production)
    [[ "$api_base_url" == "https://mail.lab86.io" ]] || {
      echo "Production IPA contains an invalid API base URL." >&2
      exit 1
    }
    [[ "$convex_url" == "https://proficient-viper-594.convex.cloud" ]] || {
      echo "Production IPA does not contain a production Convex deployment." >&2
      exit 1
    }
    [[ "$clerk_key" == pk_live_* ]] || {
      echo "Production IPA does not contain a live Clerk publishable key." >&2
      exit 1
    }
    expected_clerk_host="clerk.mail.lab86.io"
    ;;
esac

codesign --verify --deep --strict "$app_path"
entitlements="$inspection_root/entitlements.plist"
codesign -d --entitlements :- "$app_path" >"$entitlements" 2>/dev/null

team_id="$(/usr/libexec/PlistBuddy -c 'Print :com.apple.developer.team-identifier' "$entitlements" 2>/dev/null || true)"
aps_environment="$(/usr/libexec/PlistBuddy -c 'Print :aps-environment' "$entitlements" 2>/dev/null || true)"
get_task_allow="$(/usr/libexec/PlistBuddy -c 'Print :get-task-allow' "$entitlements" 2>/dev/null || true)"
associated_domains="$(/usr/libexec/PlistBuddy -c 'Print :com.apple.developer.associated-domains' "$entitlements" 2>/dev/null || true)"

[[ "$team_id" == "5JZV7V6Y4Z" ]] || {
  echo "Signed IPA has an unexpected team identifier." >&2
  exit 1
}
[[ "$aps_environment" == "production" ]] || {
  echo "Signed IPA is not provisioned for production APNs." >&2
  exit 1
}
[[ "$get_task_allow" != "true" ]] || {
  echo "Signed IPA unexpectedly allows debugger attachment." >&2
  exit 1
}
if [[ "$associated_domains" != *"webcredentials:$expected_clerk_host"* ]]; then
  echo "Signed IPA has an unexpected Clerk associated domain." >&2
  exit 1
fi

echo "Verified signed $channel IPA configuration, identity, and entitlements."
