#!/bin/sh
# Runs as root — fixes volume permissions, cleans stale Chrome locks, then drops to node
set -e

# Fix volume ownership (Railway mounts volumes as root)
mkdir -p /data/.openclaw /data/workspace
chown -R node:node /data

# Clean stale Chrome SingletonLock — left behind on unclean shutdown
# Without this, the browser tool fails silently after container restarts
find /data/.openclaw/browser -name SingletonLock -delete 2>/dev/null || true

exec tini -- gosu node "$@"
