#!/usr/bin/env bash
# Syncs the server with Cloudflare's published IP ranges (https://www.cloudflare.com/ips/):
#   - ufw: ports 80/443 open only to those ranges, so nobody can bypass Cloudflare;
#   - Caddy: the same ranges as trusted proxies, for real visitor IPs in the logs.
# Run as root on the app server after setup, and now and then (Cloudflare rarely changes them).
set -euo pipefail

V4="$(curl -fsS https://www.cloudflare.com/ips-v4)"
V6="$(curl -fsS https://www.cloudflare.com/ips-v6)"
RANGES="$(printf '%s\n%s\n' "$V4" "$V6" | grep -E '^[0-9a-f:.]+/[0-9]+$')"
[[ $(wc -l <<<"$RANGES") -ge 10 ]] || { echo "unexpected Cloudflare IP list" >&2; exit 1; }

# Drop the old cloudflare rules (highest number first so numbering stays valid), then add.
for n in $(ufw status numbered | awk -F'[][]' '/# cloudflare/ {print $2}' | sort -rn); do
  ufw --force delete "$n" >/dev/null
done
for r in $RANGES; do
  for p in 80 443; do ufw allow proto tcp from "$r" to any port "$p" comment cloudflare >/dev/null; done
done

echo "trusted_proxies static $(tr '\n' ' ' <<<"$RANGES")" >/etc/caddy/cloudflare-ips.caddy
systemctl reload caddy 2>/dev/null || true
echo "$(wc -l <<<"$RANGES") Cloudflare ranges applied"
