#!/usr/bin/env bash
# Sync apps/macos to the Mac over Tailscale and build there.
# Usage: remote-build.sh [build|run|test|clean]
set -euo pipefail

MAC_HOST="${MAC_HOST:-mac}"
REMOTE_DIR="${REMOTE_DIR:-build/lab86-mail-macos}"
ACTION="${1:-build}"
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

ssh "$MAC_HOST" "mkdir -p ~/$REMOTE_DIR"
rsync -az --delete \
  --exclude '.build' --exclude '*.xcodeproj' --exclude 'DerivedData' \
  "$SRC_DIR/" "$MAC_HOST:$REMOTE_DIR/"

ssh "$MAC_HOST" "cd ~/$REMOTE_DIR && bash scripts/mac-build.sh $ACTION"
