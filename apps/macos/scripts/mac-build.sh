#!/usr/bin/env bash
# Runs ON the Mac: generate the Xcode project with XcodeGen and build.
# Usage: mac-build.sh [build|run|test|clean]
set -euo pipefail

ACTION="${1:-build}"
TOOLS_DIR="$HOME/tools"
XCODEGEN="$TOOLS_DIR/xcodegen/bin/xcodegen"

if [ ! -x "$XCODEGEN" ]; then
  echo "==> Installing XcodeGen binary release"
  mkdir -p "$TOOLS_DIR"
  curl -fsSL -o /tmp/xcodegen.zip \
    https://github.com/yonaskolb/XcodeGen/releases/latest/download/xcodegen.zip
  ditto -x -k /tmp/xcodegen.zip "$TOOLS_DIR"
  rm -f /tmp/xcodegen.zip
fi

"$XCODEGEN" generate --quiet

DERIVED="$PWD/DerivedData"
LOG="$PWD/build.log"

case "$ACTION" in
  clean)
    rm -rf "$DERIVED" "$LOG"
    ;;
  build)
    # Ad-hoc "sign to run locally" — the login keychain is locked in SSH
    # sessions, so real identities fail with errSecInternalComponent.
    # TestFlight/release archives sign for real (PLAN.md M8).
    if xcodebuild -project Lab86Mail.xcodeproj -scheme Lab86Mail \
      -configuration Debug -destination 'platform=macOS' \
      -derivedDataPath "$DERIVED" \
      CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="-" DEVELOPMENT_TEAM="" \
      build >"$LOG" 2>&1; then
      echo "OK: build succeeded"
    else
      echo "FAILED: compile errors follow"
      grep -E "error:" "$LOG" | sort -u | head -60
      exit 1
    fi
    ;;
  run)
    open "$DERIVED/Build/Products/Debug/Lab86Mail.app"
    ;;
  test)
    xcodebuild -project Lab86Mail.xcodeproj -scheme Lab86Mail \
      -destination 'platform=macOS' -derivedDataPath "$DERIVED" test
    ;;
esac
