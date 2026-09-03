#!/bin/bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

write_plist() {
  local plist_path="$1"
  local api_base_url="$2"
  local convex_url="$3"
  local clerk_key="$4"

  /usr/libexec/PlistBuddy -c 'Clear dict' "$plist_path"
  /usr/libexec/PlistBuddy -c "Add :LAB86_API_BASE_URL string $api_base_url" "$plist_path"
  /usr/libexec/PlistBuddy -c "Add :CONVEX_DEPLOYMENT_URL string $convex_url" "$plist_path"
  /usr/libexec/PlistBuddy -c "Add :CLERK_PUBLISHABLE_KEY string $clerk_key" "$plist_path"
}

run_verifier() {
  local channel="$1"
  env -u CI_BRANCH -u CI_TAG -u CI_GIT_REF -u CI_COMMIT \
    TARGET_BUILD_DIR="$test_root" \
    INFOPLIST_PATH=Info.plist \
    LAB86_BUILD_CHANNEL="$channel" \
    "$script_dir/verify_built_configuration.sh"
}

run_branch_verifier() {
  local branch="$1"
  env -u LAB86_BUILD_CHANNEL \
    TARGET_BUILD_DIR="$test_root" \
    INFOPLIST_PATH=Info.plist \
    CI_BRANCH="$branch" \
    CI_TAG='' \
    CI_GIT_REF="refs/heads/$branch" \
    CI_COMMIT=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    "$script_dir/verify_built_configuration.sh"
}

run_tag_verifier() {
  local tag="$1"
  local commit="$2"
  env -u LAB86_BUILD_CHANNEL -u CI_BRANCH \
    TARGET_BUILD_DIR="$test_root" \
    INFOPLIST_PATH=Info.plist \
    CI_TAG="$tag" \
    CI_GIT_REF="refs/tags/$tag" \
    CI_COMMIT="$commit" \
    "$script_dir/verify_built_configuration.sh"
}

write_plist \
  "$test_root/Info.plist" \
  'https://mail.lab86.io' \
  'https://proficient-viper-594.convex.cloud' \
  'pk_live_example'
run_verifier $'```production```\r\n'
run_branch_verifier staging

write_plist \
  "$test_root/Info.plist" \
  'https://mail.lab86.iohttps://mail.lab86.io' \
  'https://proficient-viper-594.convex.cloud' \
  'pk_live_example'
if run_verifier production 2>/dev/null; then
  echo 'Release verification must reject a recursively expanded API URL.' >&2
  exit 1
fi

write_plist \
  "$test_root/Info.plist" \
  'https://mail.lab86.io' \
  'https://proficient-viper-594.convex.cloud' \
  'pk_live_example'
run_verifier production
run_branch_verifier main

if TARGET_BUILD_DIR="$test_root" \
  INFOPLIST_PATH=Info.plist \
  CI_BRANCH=main \
  CI_TAG='' \
  CI_GIT_REF=refs/heads/main \
  CI_COMMIT=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  LAB86_BUILD_CHANNEL=staging \
  "$script_dir/verify_built_configuration.sh" 2>/dev/null; then
  echo 'Branch verification must reject a mismatched explicit channel.' >&2
  exit 1
fi

if TARGET_BUILD_DIR="$test_root" \
  INFOPLIST_PATH=Info.plist \
  CI_BRANCH='```main```' \
  CI_TAG='' \
  CI_GIT_REF=refs/heads/main \
  CI_COMMIT=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  LAB86_BUILD_CHANNEL=production \
  "$script_dir/verify_built_configuration.sh" 2>/dev/null; then
  echo 'A malformed Xcode Cloud branch must not select production.' >&2
  exit 1
fi

if TARGET_BUILD_DIR="$test_root" \
  INFOPLIST_PATH=Info.plist \
  CI_BRANCH=feature \
  CI_TAG='' \
  CI_GIT_REF=refs/heads/feature \
  CI_COMMIT=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  LAB86_BUILD_CHANNEL=production \
  "$script_dir/verify_built_configuration.sh" 2>/dev/null; then
  echo 'Branch verification must reject an unknown Xcode Cloud branch.' >&2
  exit 1
fi

staging_sha=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
run_tag_verifier "ios-staging-$staging_sha" "$staging_sha"
run_tag_verifier v0.10.0 cccccccccccccccccccccccccccccccccccccccc

if run_tag_verifier "ios-staging-$staging_sha" dddddddddddddddddddddddddddddddddddddddd 2>/dev/null; then
  echo 'Tag verification must reject a staging tag whose embedded SHA differs from CI_COMMIT.' >&2
  exit 1
fi

write_plist \
  "$test_root/Info.plist" \
  'https://mail.lab86.io' \
  'https://proficient-viper-594.convex.cloud' \
  'pk_test_example'
if run_verifier production 2>/dev/null; then
  echo 'Production verification must reject a Clerk test key.' >&2
  exit 1
fi

write_plist \
  "$test_root/Info.plist" \
  'https://mail.lab86.io' \
  'https://unrelated-production.convex.cloud' \
  'pk_live_example'
if run_verifier production 2>/dev/null; then
  echo 'Production verification must reject an unrelated Convex deployment.' >&2
  exit 1
fi

if run_verifier preview 2>/dev/null; then
  echo 'Release verification must reject an unknown build channel.' >&2
  exit 1
fi

# A local Debug build skips the gate; a generic CI runner with CI=true must not.
env -u CI_BRANCH -u CI_TAG -u CI_GIT_REF -u CI_COMMIT -u CI \
  CONFIGURATION=Debug TARGET_BUILD_DIR="$test_root/missing" INFOPLIST_PATH=Info.plist \
  "$script_dir/verify_built_configuration.sh" >/dev/null
if env -u CI_BRANCH -u CI_TAG -u CI_GIT_REF -u CI_COMMIT \
  CI=true CONFIGURATION=Debug TARGET_BUILD_DIR="$test_root/missing" INFOPLIST_PATH=Info.plist \
  "$script_dir/verify_built_configuration.sh" 2>/dev/null; then
  echo 'A CI=true Debug build must not bypass release verification.' >&2
  exit 1
fi

# Signed entitlements must carry a concrete webcredentials host.
write_plist \
  "$test_root/Info.plist" \
  'https://mail.lab86.io' \
  'https://proficient-viper-594.convex.cloud' \
  'pk_live_example'
write_entitlements() {
  local path="$1"
  local webcredentials="$2"
  rm -f "$path"
  /usr/libexec/PlistBuddy -c 'Add :com.apple.developer.associated-domains array' "$path"
  /usr/libexec/PlistBuddy -c 'Add :com.apple.developer.associated-domains:0 string applinks:mail.lab86.io' "$path"
  /usr/libexec/PlistBuddy -c "Add :com.apple.developer.associated-domains:1 string $webcredentials" "$path"
}
write_entitlements "$test_root/app.xcent" 'webcredentials:clerk.mail.lab86.io'
LAB86_ENTITLEMENTS_FILE="$test_root/app.xcent" run_verifier production >/dev/null
for bad in 'webcredentials:' 'webcredentials:$(LAB86_INFO_CLERK_FRONTEND_API_HOST)' 'webcredentials:https://clerk.mail.lab86.io' 'webcredentials:clerk.mail.lab86.io/path'; do
  write_entitlements "$test_root/app.xcent" "$bad"
  if LAB86_ENTITLEMENTS_FILE="$test_root/app.xcent" run_verifier production 2>/dev/null; then
    echo "Release verification must reject the entitlement '$bad'." >&2
    exit 1
  fi
done

printf 'built configuration verification tests passed\n'
