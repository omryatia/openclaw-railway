# ------------------------------------------------------------------
# Stage 1: Build OpenClaw from source
# ------------------------------------------------------------------
FROM node:22-bookworm AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /build

ARG OPENCLAW_REF=v2026.3.7
RUN git clone https://github.com/openclaw/openclaw.git . && git checkout "${OPENCLAW_REF}"

RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm ui:install
RUN pnpm ui:build

# ------------------------------------------------------------------
# Stage 2: Runtime
# ------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    tini \
    gosu \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/openclaw

COPY --from=builder /build/ /app/openclaw/

COPY wrapper/server.js /app/wrapper/server.js
COPY wrapper/package.json /app/wrapper/package.json
COPY config/openclaw.json /app/openclaw-defaults.json
COPY entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh && chown -R node:node /app

ENV NODE_ENV=production
ENV OPENCLAW_STATE_DIR=/data/.openclaw
ENV OPENCLAW_WORKSPACE_DIR=/data/workspace

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:8080/healthz', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "/app/wrapper/server.js"]
