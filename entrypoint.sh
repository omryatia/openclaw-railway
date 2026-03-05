#!/bin/sh

# Runs as root:
# 1. Fix volume permissions (Railway mounts volumes as root)
# 2. Clean stale Chrome SingletonLock files
# 3. Start tailscaled if TAILSCALE_AUTH_KEY is set
# 4. Drop to node user

set -e

# Fix volume ownership
mkdir -p /data/.openclaw /data/workspace
chown -R node:node /data

# Clean stale Chrome locks — causes silent browser failures after unclean shutdown
find /data/.openclaw/browser -name SingletonLock -delete 2>/dev/null || true

# Optional Tailscale — only starts if TAILSCALE_AUTH_KEY is provided
if [ -n "$TAILSCALE_AUTH_KEY" ]; then
  echo "[entrypoint] Starting tailscaled..."
  # Persist Tailscale state on the volume so it doesn't re-register on every deploy
  mkdir -p /data/.tailscale /var/run/tailscale
  tailscaled --state=/data/.tailscale/tailscaled.state --socket=/var/run/tailscale/tailscaled.sock &
  # Give tailscaled a moment to start, then connect
  sleep 3
  tailscale up \
    --auth-key="$TAILSCALE_AUTH_KEY" \
    --hostname="openclaw-railway" \
    --accept-routes 2>/dev/null || true

  # Expose the wrapper's HTTP port via Tailscale HTTPS (MagicDNS)
  # This makes https://openclaw-railway.<tailnet>.ts.net → localhost:8080
  sleep 1
  tailscale serve --bg http://localhost:8080 2>/dev/null || \
    tailscale serve --bg 8080 2>/dev/null || \
    echo "[entrypoint] Warning: tailscale serve failed — you may need to configure it manually"

  TAILSCALE_IP=$(tailscale ip -4 2>/dev/null || echo "unknown")
  TAILNET_NAME=$(tailscale status --json 2>/dev/null | grep -o '"MagicDNSSuffix":"[^"]*"' | cut -d'"' -f4 || echo "your-tailnet.ts.net")
  echo "[entrypoint] Tailscale up — IP: ${TAILSCALE_IP}"
  echo "[entrypoint] Access via: https://openclaw-railway.${TAILNET_NAME}"
fi

exec tini -- gosu node "$@"
