# ─────────────────────────────────────────────
# Stage 1: Build OpenClaw from source
# ─────────────────────────────────────────────
FROM node:22-bookworm AS builder

# Install Bun (required for build scripts) and enable corepack for pnpm
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"
RUN corepack enable

WORKDIR /build

# Cache dependency layers — only re-run install if lockfiles change
ARG OPENCLAW_VERSION=latest
RUN npm install -g openclaw@${OPENCLAW_VERSION} --ignore-scripts || true

# Build from source for full control
RUN git clone --depth=1 https://github.com/openclaw/openclaw.git . 2>/dev/null || true

COPY --chown=node:node . .

RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm ui:install
RUN pnpm ui:build

# ─────────────────────────────────────────────
# Stage 2: Runtime — lean, non-root
# ─────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

# tini: proper PID 1, signal forwarding, zombie reaping
RUN apt-get update && apt-get install -y --no-install-recommends \
    tini \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Wrapper dependencies
WORKDIR /app/wrapper
COPY wrapper/package.json ./
RUN npm install --omit=dev

# Copy built OpenClaw
COPY --from=builder /build/dist /app/openclaw/dist
COPY --from=builder /build/ui/dist /app/openclaw/ui/dist
COPY --from=builder /build/node_modules /app/openclaw/node_modules
COPY --from=builder /build/package.json /app/openclaw/package.json

# Copy wrapper server
COPY wrapper/server.js /app/wrapper/server.js

# Persistent data lives here (Railway Volume mounts /data)
RUN mkdir -p /data/.openclaw /data/workspace \
    && chown -R node:node /data

# Config scaffold (overridden by /data/.openclaw/openclaw.json at runtime)
COPY config/openclaw.json /app/openclaw-defaults.json

# Run as non-root
USER node

ENV NODE_ENV=production
ENV OPENCLAW_DIR=/data/.openclaw
ENV OPENCLAW_WORKSPACE=/data/workspace

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/healthz', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/wrapper/server.js"]
