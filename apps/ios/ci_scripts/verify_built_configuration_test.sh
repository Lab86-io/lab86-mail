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
  TARGET_BUILD_DIR="$test_root" \
    INFOPLIST_PATH=Info.plist \
    LAB86_BUILD_CHANNEL="$channel" \
    "$script_dir/verify_built_configuration.sh"
}

write_plist \
  "$test_root/Info.plist" \
  'https://mail-staging.lab86.io' \
  'https://precise-skunk-847.convex.cloud' \
  'pk_test_example'
run_verifier $'```staging```\r\n'

write_plist \
  "$test_root/Info.plist" \
  'https://mail-staging.lab86.iohttps://mail-staging.lab86.io' \
  'https://precise-skunk-847.convex.cloud' \
  'pk_test_example'
if run_verifier staging 2>/dev/null; then
  echo 'Staging verification must reject a recursively expanded API URL.' >&2
  exit 1
fi

write_plist \
  "$test_root/Info.plist" \
  'https://mail.lab86.io' \
  'https://proficient-viper-594.convex.cloud' \
  'pk_live_example'
run_verifier production

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

printf 'built configuration verification tests passed\n'
