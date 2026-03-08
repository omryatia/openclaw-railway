#!/bin/sh
set -e

mkdir -p /data/.openclaw /data/workspace
chown -R node:node /data

find /data/.openclaw/browser -name SingletonLock -delete 2>/dev/null || true
find /data/.openclaw/browser -name SingletonCookie -delete 2>/dev/null || true
find /data/.openclaw/browser -name SingletonSocket -delete 2>/dev/null || true

exec tini -- gosu node "$@"
