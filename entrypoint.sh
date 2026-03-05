#!/bin/sh

# Runs as root:
# 1. Fix volume permissions (Railway mounts volumes as root)
# 2. Clean stale Chrome SingletonLock files
# 3. Drop to node user

set -e

# Fix volume ownership
mkdir -p /data/.openclaw /data/workspace
chown -R node:node /data

# Clean stale Chrome locks — causes silent browser failures after unclean shutdown
find /data/.openclaw/browser -name SingletonLock -delete 2>/dev/null || true

exec tini -- gosu node "$@"
