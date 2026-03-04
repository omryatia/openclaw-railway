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

# Show built paths for debugging
RUN echo "=== /build/dist ===" && ls /build/dist/ 2>/dev/null || echo "no dist" && \
    echo "=== UI html files ===" && find /build -name "index.html" 2>/dev/null | head -10

# ─────────────────────────────────────────────
# Stage 2: Runtime
# ─────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    tini \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /root/.bun /root/.bun
ENV PATH="/root/.bun/bin:${PATH}"

# Copy entire build output — includes UI assets bundled into dist
WORKDIR /app/openclaw
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./package.json

# Copy wrapper
WORKDIR /app/wrapper
COPY wrapper/server.js ./server.js

# Config scaffold
COPY config/openclaw.json /app/openclaw-defaults.json

RUN mkdir -p /data/.openclaw /data/workspace \
    && chown -R node:node /data /app

USER node

ENV NODE_ENV=production
ENV OPENCLAW_DIR=/data/.openclaw
ENV OPENCLAW_WORKSPACE=/data/workspace

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD bun -e "require('http').get('http://localhost:8080/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "run", "/app/wrapper/server.js"]
