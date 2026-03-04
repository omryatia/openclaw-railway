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
  mkdir -p /var/lib/tailscale
  tailscaled --state=/var/lib/tailscale/tailscaled.state --socket=/var/run/tailscale/tailscaled.sock &
  # Give tailscaled a moment to start, then connect
  sleep 2
  tailscale up --auth-key="$TAILSCALE_AUTH_KEY" --hostname="openclaw-railway" --accept-routes 2>/dev/null || true
  echo "[entrypoint] Tailscale up — MagicDNS hostname: openclaw-railway"
fi

exec tini -- gosu node "$@"
