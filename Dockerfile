# ─────────────────────────────────────────────
# Stage 1: Build OpenClaw from source
# ─────────────────────────────────────────────
FROM node:22-bookworm AS builder

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /build
RUN git clone --depth=1 https://github.com/openclaw/openclaw.git .

RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm ui:install
RUN pnpm ui:build

# ─────────────────────────────────────────────
# Stage 2: Runtime
# ─────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

# Runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    tini \
    gosu \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy runtime files from the OpenClaw build.
# The official Dockerfile does `COPY . .` — we're selective but thorough.
WORKDIR /app/openclaw
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./package.json
# UI assets — needed for the Control UI served by the gateway
COPY --from=builder /build/ui ./ui
# Workspace templates (AGENTS.md, SOUL.md, etc.) — required for sessions
COPY --from=builder /build/docs ./docs
# Source files — some runtime paths resolve relative to source
COPY --from=builder /build/src ./src

# Verify critical files exist (fail build early if missing)
RUN test -f docs/reference/templates/AGENTS.md \
    || (echo "ERROR: docs/reference/templates/AGENTS.md missing from build" && exit 1)

# Copy wrapper and config
COPY wrapper/server.js /app/wrapper/server.js
COPY wrapper/package.json /app/wrapper/package.json
COPY config/openclaw.json /app/openclaw-defaults.json
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && chown -R node:node /app

ENV NODE_ENV=production

# FIX #1 continued: Use the correct OpenClaw env var names.
# OPENCLAW_STATE_DIR is what OpenClaw actually reads (not OPENCLAW_DIR).
# OPENCLAW_WORKSPACE_DIR is the standard var (not OPENCLAW_WORKSPACE).
ENV OPENCLAW_STATE_DIR=/data/.openclaw
ENV OPENCLAW_WORKSPACE_DIR=/data/workspace

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Run as root so entrypoint can chown /data, then drops to node
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "/app/wrapper/server.js"]
