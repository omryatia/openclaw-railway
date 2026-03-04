# ─────────────────────────────────────────────
# Stage 1: Build OpenClaw from source using Bun + pnpm
# ─────────────────────────────────────────────
FROM node:22-bookworm AS builder

# Install Bun and enable corepack for pnpm
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /build

# Clone latest stable OpenClaw
RUN git clone --depth=1 https://github.com/openclaw/openclaw.git .

# Cache dependency layer — only re-runs if lockfiles change
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm ui:install
RUN pnpm ui:build

# ─────────────────────────────────────────────
# Stage 2: Runtime — lean, non-root, bun-powered
# ─────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

# tini: proper PID 1, signal forwarding, zombie reaping
RUN apt-get update && apt-get install -y --no-install-recommends \
    tini \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy Bun from builder — use it to run the wrapper (faster startup, no npm needed)
COPY --from=builder /root/.bun /root/.bun
ENV PATH="/root/.bun/bin:${PATH}"

# Copy built OpenClaw
WORKDIR /app/openclaw
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/ui/dist ./ui/dist
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./package.json

# Copy wrapper — no install needed, uses only Node built-ins
WORKDIR /app/wrapper
COPY wrapper/server.js ./server.js

# Config scaffold (overridden by /data/.openclaw/openclaw.json at runtime)
COPY config/openclaw.json /app/openclaw-defaults.json

# Persistent data lives here (Railway Volume mounts /data)
RUN mkdir -p /data/.openclaw /data/workspace \
    && chown -R node:node /data /app

# Run as non-root
USER node

ENV NODE_ENV=production
ENV OPENCLAW_DIR=/data/.openclaw
ENV OPENCLAW_WORKSPACE=/data/workspace

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD bun -e "const r=require('http').get('http://localhost:8080/healthz',r=>process.exit(r.statusCode===200?0:1));r.on('error',()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "run", "/app/wrapper/server.js"]
