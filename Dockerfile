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

# su-exec: drop privileges after fixing volume ownership at runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    tini \
    su-exec \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy built OpenClaw
WORKDIR /app/openclaw
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./package.json

# Copy wrapper and config
COPY wrapper/server.js /app/wrapper/server.js
COPY config/openclaw.json /app/openclaw-defaults.json
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && chown -R node:node /app

ENV NODE_ENV=production
ENV OPENCLAW_DIR=/data/.openclaw
ENV OPENCLAW_WORKSPACE=/data/workspace

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Run as root so entrypoint can chown /data, then drops to node
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "/app/wrapper/server.js"]
