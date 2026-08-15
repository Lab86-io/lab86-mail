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
# immutable source ref, exactly as ci_post_clone.sh does, and only use the
# explicit channel for local/non-cloud builds.
normalize_cloud_value() {
  printf '%s' "$1" | tr -d '`\r\n'
}

cloud_branch="${CI_BRANCH:-}"
cloud_tag="${CI_TAG:-}"
cloud_git_ref="${CI_GIT_REF:-}"
cloud_commit="${CI_COMMIT:-}"
requested_build_channel="$(normalize_cloud_value "${LAB86_BUILD_CHANNEL:-}")"
source_build_channel=
authorized_source=false

case "$cloud_git_ref" in
  refs/heads/main|refs/heads/staging)
    expected_branch="${cloud_git_ref#refs/heads/}"
    [[ "$cloud_branch" == "$expected_branch" && -z "$cloud_tag" ]] && authorized_source=true
    ;;
  refs/tags/ios-staging-*)
    expected_commit="${cloud_tag#ios-staging-}"
    if [[ -z "$cloud_branch" \
      && "$cloud_git_ref" == "refs/tags/$cloud_tag" \
      && "$expected_commit" =~ ^[0-9a-f]{40}$ \
      && "$cloud_commit" == "$expected_commit" ]]; then
      authorized_source=true
    fi
    ;;
  refs/tags/v*)
    if [[ -z "$cloud_branch" \
      && "$cloud_git_ref" == "refs/tags/$cloud_tag" \
      && "$cloud_tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ \
      && "$cloud_commit" =~ ^[0-9a-f]{40}$ ]]; then
      authorized_source=true
    fi
    ;;
esac

if [[ -n "$cloud_git_ref" ]]; then
  if [[ "$authorized_source" != true ]]; then
    echo "Xcode Cloud builds must originate from an authorized main, staging, or immutable release ref." >&2
    exit 1
  fi
  source_build_channel=production
elif [[ -n "$cloud_branch" || -n "$cloud_tag" || -n "$cloud_commit" ]]; then
  echo "An incomplete Xcode Cloud source identity is not authorized." >&2
  exit 1
fi

if [[ -n "$source_build_channel" \
  && -n "$requested_build_channel" \
  && "$requested_build_channel" != "$source_build_channel" ]]; then
  echo "LAB86_BUILD_CHANNEL does not match Xcode Cloud source $cloud_git_ref." >&2
  exit 1
fi

build_channel="${source_build_channel:-${requested_build_channel:-production}}"

echo "Verifying release configuration: channel=$build_channel api=$api_base_url convex=$convex_url"

case "$build_channel" in
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
