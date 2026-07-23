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
  CLERK_FRONTEND_API_HOST LAB86_BUILD_CHANNEL CI_BRANCH
run_post_clone

default_key="pk_test_$(printf '%s$' 'together-sawfish-53.clerk.accounts.dev' | base64 | tr -d '\n')"
expected_default="LAB86_INFO_API_BASE_URL = https:/\$()/mail-staging.lab86.io
LAB86_INFO_CLERK_PUBLISHABLE_KEY = $default_key
LAB86_INFO_CONVEX_DEPLOYMENT_URL = https:/\$()/precise-skunk-847.convex.cloud
LAB86_INFO_CLERK_FRONTEND_API_HOST = together-sawfish-53.clerk.accounts.dev"
actual="$(< "$test_root/repository/apps/ios/Config/Local.xcconfig")"
[[ "$actual" == "$expected_default" ]]

export LAB86_API_BASE_URL='```https:/$()/api.example.com```'
export CONVEX_DEPLOYMENT_URL='```https:/$()/convex.example.com```'
export CLERK_FRONTEND_API_HOST='```clerk.example.com```'
export CLERK_PUBLISHABLE_KEY='```pk_test_example```'
run_post_clone

# A staging build must ignore stale or malformed Xcode Cloud overrides.
expected_override="$expected_default"
actual="$(< "$test_root/repository/apps/ios/Config/Local.xcconfig")"
[[ "$actual" == "$expected_override" ]]

unset LAB86_API_BASE_URL CLERK_PUBLISHABLE_KEY CONVEX_DEPLOYMENT_URL \
  CLERK_FRONTEND_API_HOST
unset LAB86_BUILD_CHANNEL
export CI_BRANCH=main
run_post_clone

production_key="pk_live_$(printf '%s$' 'clerk.mail.lab86.io' | base64 | tr -d '\n=')"
expected_production="LAB86_INFO_API_BASE_URL = https:/\$()/mail.lab86.io
LAB86_INFO_CLERK_PUBLISHABLE_KEY = $production_key
LAB86_INFO_CONVEX_DEPLOYMENT_URL = https:/\$()/proficient-viper-594.convex.cloud
LAB86_INFO_CLERK_FRONTEND_API_HOST = clerk.mail.lab86.io"
actual="$(< "$test_root/repository/apps/ios/Config/Local.xcconfig")"
[[ "$actual" == "$expected_production" ]]

export LAB86_API_BASE_URL='https://mail.lab86.io'
export CONVEX_DEPLOYMENT_URL='https://proficient-viper-594.convex.cloud'
export CLERK_FRONTEND_API_HOST='clerk.mail.lab86.io'
export CLERK_PUBLISHABLE_KEY="$production_key"
run_post_clone

export CONVEX_DEPLOYMENT_URL='https://unrelated-production.convex.cloud'
if run_post_clone 2>/dev/null; then
  echo 'Production configuration must reject an unrelated Convex deployment.' >&2
  exit 1
fi
export CONVEX_DEPLOYMENT_URL='https://proficient-viper-594.convex.cloud'
export CLERK_FRONTEND_API_HOST='unrelated.clerk.accounts.dev'
if run_post_clone 2>/dev/null; then
  echo 'Production configuration must reject an unrelated Clerk frontend host.' >&2
  exit 1
fi

unset LAB86_BUILD_CHANNEL LAB86_API_BASE_URL CLERK_PUBLISHABLE_KEY \
  CONVEX_DEPLOYMENT_URL CLERK_FRONTEND_API_HOST
export CI_BRANCH=feature/not-a-release
if run_post_clone 2>/dev/null; then
  echo 'An unknown Xcode Cloud branch must fail closed.' >&2
  exit 1
fi

printf 'ci_post_clone configuration tests passed\n'
