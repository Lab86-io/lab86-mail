#!/bin/bash
set -euo pipefail

info_plist="${TARGET_BUILD_DIR:-}/${INFOPLIST_PATH:-}"
if [[ ! -f "$info_plist" ]]; then
  echo "Processed application Info.plist is unavailable for release verification." >&2
  exit 1
fi

plist_value() {
  /usr/libexec/PlistBuddy -c "Print :$1" "$info_plist"
}

api_base_url="$(plist_value LAB86_API_BASE_URL)"
convex_url="$(plist_value CONVEX_DEPLOYMENT_URL)"
clerk_key="$(plist_value CLERK_PUBLISHABLE_KEY)"
# Xcode Cloud's environment editor can retain Markdown backticks and line
# endings around a pasted value. Normalize the channel exactly as post-clone
# does so both phases validate the same release environment.
build_channel="$(printf '%s' "${LAB86_BUILD_CHANNEL:-staging}" | tr -d '`\r\n')"

echo "Verifying release configuration: channel=$build_channel api=$api_base_url convex=$convex_url"

case "$build_channel" in
  staging)
    [[ "$api_base_url" == "https://mail-staging.lab86.io" ]] || {
      echo "Refusing to archive a staging app with an invalid API base URL." >&2
      exit 1
    }
    [[ "$convex_url" == "https://precise-skunk-847.convex.cloud" ]] || {
      echo "Refusing to archive a staging app with an invalid Convex deployment." >&2
      exit 1
    }
    [[ "$clerk_key" == pk_test_* ]] || {
      echo "Refusing to archive a staging app without a Clerk test key." >&2
      exit 1
    }
    ;;
  production)
    [[ "$api_base_url" == "https://mail.lab86.io" ]] || {
      echo "Refusing to archive a production app with an invalid API base URL." >&2
      exit 1
    }
    [[ "$convex_url" == "https://proficient-viper-594.convex.cloud" ]] || {
      echo "Refusing to archive a production app without production Convex." >&2
      exit 1
    }
    [[ "$clerk_key" == pk_live_* ]] || {
      echo "Refusing to archive a production app without a live Clerk key." >&2
      exit 1
    }
    ;;
  *)
    echo "Unsupported LAB86_BUILD_CHANNEL: $build_channel" >&2
    exit 1
    ;;
esac

echo "Verified processed $build_channel application configuration."
