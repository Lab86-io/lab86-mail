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

# Xcode Cloud does not guarantee that custom workflow environment variables
# remain available to target build phases. Derive the release channel from its
# immutable source branch, exactly as ci_post_clone.sh does, and only use the
# explicit channel for local/non-cloud builds.
normalize_cloud_value() {
  printf '%s' "$1" | tr -d '`\r\n'
}

cloud_branch="$(normalize_cloud_value "${CI_BRANCH:-}")"
requested_build_channel="$(normalize_cloud_value "${LAB86_BUILD_CHANNEL:-}")"
case "$cloud_branch" in
  main)
    branch_build_channel=production
    ;;
  staging)
    branch_build_channel=staging
    ;;
  "")
    branch_build_channel=
    ;;
  *)
    echo "Xcode Cloud builds must originate from main or staging." >&2
    exit 1
    ;;
esac

if [[ -n "$branch_build_channel" \
  && -n "$requested_build_channel" \
  && "$requested_build_channel" != "$branch_build_channel" ]]; then
  echo "LAB86_BUILD_CHANNEL does not match Xcode Cloud branch $cloud_branch." >&2
  exit 1
fi

build_channel="${branch_build_channel:-${requested_build_channel:-staging}}"

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
