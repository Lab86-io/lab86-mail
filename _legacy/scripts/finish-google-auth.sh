#!/usr/bin/env bash
set -euo pipefail

email="${1:?email required}"
redirect_url="${2:-}"
client="${MAIL_OS_AUTH_CLIENT:-jjalangtry-gmail}"
gog="${MAIL_OS_GOG_BIN:-/home/jjalangtry/.local/bin/lab86-gog}"

if [[ -z "$redirect_url" ]]; then
  read -r -p "Paste redirect URL: " redirect_url
fi

exec "$gog" --client "$client" auth add "$email" \
  --remote \
  --step=2 \
  --auth-url "$redirect_url" \
  --services=gmail,calendar,contacts,people \
  --gmail-scope=full \
  --force-consent
