#!/bin/bash
set -euo pipefail

platform="${1:?Pass ios or macos}"
case "$platform" in ios|macos) ;; *) exit 2 ;; esac
mkdir -p native-evidence
# Canonical public configuration, exactly as in ci_post_clone.sh. No secrets,
# signing keys, source mutations, TestFlight uploads, or provider writes.
native_clerk_host=clerk.mail.lab86.io
native_clerk_key="pk_live_$(printf '%s$' "$native_clerk_host" | base64 | tr -d '\n=')"
common=(
  -project apps/ios/Lab86Mail.xcodeproj
  -configuration Debug
  -derivedDataPath "${RUNNER_TEMP:?}/native-${platform}"
  -skipPackagePluginValidation -skipMacroValidation
  CODE_SIGNING_ALLOWED=NO
  # Match the verified unsigned Xcode 27 beta builds: avoid preview-stub linking.
  ENABLE_DEBUG_DYLIB=NO
  LAB86_INFO_API_BASE_URL=https://mail.lab86.io
  LAB86_INFO_CONVEX_DEPLOYMENT_URL=https://proficient-viper-594.convex.cloud
  "LAB86_INFO_CLERK_PUBLISHABLE_KEY=$native_clerk_key"
  "LAB86_INFO_CLERK_FRONTEND_API_HOST=$native_clerk_host"
)

if [[ "$platform" == ios ]]; then
  native_simulator_id="$(xcrun simctl list devices available -j | node -e '
    let data = "";
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => {
      const device = Object.entries(JSON.parse(data).devices)
        .filter(([runtime]) => runtime.includes("iOS-27"))
        .flatMap(([, devices]) => devices)
        .find((device) => device.isAvailable && device.name.startsWith("iPhone"));
      if (!device) process.exit(1);
      process.stdout.write(device.udid);
    });
  ')"
  xcodebuild "${common[@]}" -scheme Lab86Mail \
    -destination "platform=iOS Simulator,id=$native_simulator_id" \
    -only-testing:Lab86MailTests \
    -resultBundlePath native-evidence/ios-tests.xcresult test \
    2>&1 | tee native-evidence/ios-build.log
  xcodebuild "${common[@]}" -scheme Lab86Mail \
    -destination 'generic/platform=iOS' build \
    2>&1 | tee native-evidence/ios-device-build.log
else
  # The runner host cannot execute a macOS 27 application. Do not lower the
  # deployment target to manufacture a green run: compile the app and tests.
  xcodebuild "${common[@]}" -scheme Lab86MailMac \
    -destination 'generic/platform=macOS' build-for-testing \
    2>&1 | tee native-evidence/macos-build.log
fi
