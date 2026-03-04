#!/bin/sh
# Runs as root — creates dirs on the volume and fixes ownership, then drops to node user
set -e

mkdir -p /data/.openclaw /data/workspace
chown -R node:node /data

exec tini -- su-exec node "$@"
