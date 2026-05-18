#!/usr/bin/env bash
set -euo pipefail

email="${1:?email required}"
client="${2:-${MAIL_OS_AUTH_CLIENT:-jjalangtry-gmail}}"
gog="${MAIL_OS_GOG_BIN:-/home/jjalangtry/.local/bin/lab86-gog}"

exec "$gog" --client "$client" auth add "$email" \
  --remote \
  --step=1 \
  --services=gmail,calendar,contacts,people \
  --gmail-scope=full \
  --force-consent
