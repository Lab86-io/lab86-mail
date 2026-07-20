#!/bin/bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

mkdir -p "$test_root/repository/apps/ios/Config" "$test_root/bin"
for command_name in brew defaults xcodegen; do
  printf '#!/bin/sh\nexit 0\n' > "$test_root/bin/$command_name"
  chmod +x "$test_root/bin/$command_name"
done

run_post_clone() {
  CI_PRIMARY_REPOSITORY_PATH="$test_root/repository" \
    PATH="$test_root/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    bash "$script_dir/ci_post_clone.sh"
}

unset LAB86_API_BASE_URL CLERK_PUBLISHABLE_KEY CONVEX_DEPLOYMENT_URL \
  CLERK_FRONTEND_API_HOST
run_post_clone

default_key="pk_test_$(printf '%s$' 'together-sawfish-53.clerk.accounts.dev' | base64 | tr -d '\n')"
expected_default="LAB86_API_BASE_URL = https:/\$()/mail-staging.lab86.io
CLERK_PUBLISHABLE_KEY = $default_key
CONVEX_DEPLOYMENT_URL = https:/\$()/precise-skunk-847.convex.cloud
CLERK_FRONTEND_API_HOST = together-sawfish-53.clerk.accounts.dev"
actual="$(< "$test_root/repository/apps/ios/Config/Local.xcconfig")"
[[ "$actual" == "$expected_default" ]]

export LAB86_API_BASE_URL='```https:/$()/api.example.com```'
export CONVEX_DEPLOYMENT_URL='```https:/$()/convex.example.com```'
export CLERK_FRONTEND_API_HOST='```clerk.example.com```'
export CLERK_PUBLISHABLE_KEY='```pk_test_example```'
run_post_clone

expected_override='LAB86_API_BASE_URL = https:/$()/api.example.com
CLERK_PUBLISHABLE_KEY = pk_test_example
CONVEX_DEPLOYMENT_URL = https:/$()/convex.example.com
CLERK_FRONTEND_API_HOST = clerk.example.com'
actual="$(< "$test_root/repository/apps/ios/Config/Local.xcconfig")"
[[ "$actual" == "$expected_override" ]]

printf 'ci_post_clone configuration tests passed\n'
