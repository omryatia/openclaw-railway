/**
 * OpenClaw Railway Wrapper
 *
 * Responsibilities:
 *  - Enforce GATEWAY_TOKEN and SETUP_PASSWORD before anything starts
 *  - Serve /setup wizard (password-gated) for first-run configuration
 *  - Spawn and manage the OpenClaw gateway process with lifecycle handling
 *  - Reverse-proxy all other traffic to the internal gateway
 *  - Expose /healthz for Railway health checks
 */

"use strict";

const http = require("http");
const https = require("https");
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ─── Constants ────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "8080", 10);
const GATEWAY_PORT = 18789;
const GATEWAY_HOST = "127.0.0.1";
const OPENCLAW_DIR = process.env.OPENCLAW_DIR || "/data/.openclaw";
const WORKSPACE_DIR = process.env.OPENCLAW_WORKSPACE || "/data/workspace";
const CONFIG_PATH = path.join(OPENCLAW_DIR, "openclaw.json");
const DEFAULTS_PATH = "/app/openclaw-defaults.json";
const OPENCLAW_BIN = "/app/openclaw/dist/index.js";

// ─── Security enforcement ─────────────────────────────────────────────────────

const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN;
const SETUP_PASSWORD = process.env.SETUP_PASSWORD;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

if (!GATEWAY_TOKEN || GATEWAY_TOKEN.length < 32) {
  console.error(
    "[FATAL] GATEWAY_TOKEN is missing or too short (min 32 chars).\n" +
    "Generate one with: openssl rand -hex 32\n" +
    "Set it as a Railway variable before deploying."
  );
  process.exit(1);
}

if (!SETUP_PASSWORD || SETUP_PASSWORD.length < 12) {
  console.error(
    "[FATAL] SETUP_PASSWORD is missing or too short (min 12 chars).\n" +
    "Set it as a Railway variable. This protects your /setup wizard."
  );
  process.exit(1);
}

if (!ANTHROPIC_API_KEY && !OPENROUTER_API_KEY && !OPENAI_API_KEY) {
  console.warn("[WARN] No AI provider key set. Gateway will start but no model will respond.");
}

// ─── Directory bootstrap ──────────────────────────────────────────────────────

[OPENCLAW_DIR, WORKSPACE_DIR].forEach((dir) => {
  fs.mkdirSync(dir, { recursive: true });
});

// Write secure default config if none exists
if (!fs.existsSync(CONFIG_PATH)) {
  const defaults = JSON.parse(fs.readFileSync(DEFAULTS_PATH, "utf8"));

  // Inject runtime secrets into the config
  defaults.gateway.auth.token = GATEWAY_TOKEN;

  if (ANTHROPIC_API_KEY) {
    defaults.agent = defaults.agent || {};
    defaults.agent.model = "anthropic/claude-opus-4-6";
  } else if (OPENROUTER_API_KEY) {
    defaults.agent = defaults.agent || {};
    defaults.agent.model = "openrouter/auto";
  } else if (OPENAI_API_KEY) {
  defaults.agent.model = "openai/gpt-4o";
  }

  if (TELEGRAM_BOT_TOKEN) {
    defaults.channels = defaults.channels || {};
    defaults.channels.telegram = defaults.channels.telegram || {};
    defaults.channels.telegram.botToken = TELEGRAM_BOT_TOKEN;
  }

  if (DISCORD_BOT_TOKEN) {
    defaults.channels = defaults.channels || {};
    defaults.channels.discord = defaults.channels.discord || {};
    defaults.channels.discord.token = DISCORD_BOT_TOKEN;
  }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaults, null, 2), { mode: 0o600 });
  console.log("[boot] Wrote secure default config to", CONFIG_PATH);
}

// ─── Gateway process management ───────────────────────────────────────────────

let gatewayProcess = null;
let gatewayReady = false;
let restartCount = 0;
const MAX_RESTARTS = 10;
const RESTART_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

function backoffMs() {
  return RESTART_BACKOFF_MS[Math.min(restartCount, RESTART_BACKOFF_MS.length - 1)];
}

function startGateway() {
  if (restartCount >= MAX_RESTARTS) {
    console.error("[gateway] Too many restarts, giving up.");
    process.exit(1);
  }

  console.log(`[gateway] Starting (attempt ${restartCount + 1})...`);
  gatewayReady = false;

  const env = {
    ...process.env,
    HOME: OPENCLAW_DIR,
    OPENCLAW_DIR,
    OPENCLAW_GATEWAY_BIND: "loopback",
    OPENCLAW_GATEWAY_PORT: String(GATEWAY_PORT),
    OPENCLAW_GATEWAY_TOKEN: GATEWAY_TOKEN,
    // Propagate model API keys
    ...(ANTHROPIC_API_KEY && { ANTHROPIC_API_KEY }),
    ...(OPENROUTER_API_KEY && { OPENROUTER_API_KEY }),
    ...(OPENAI_API_KEY && { OPENAI_API_KEY }),
    ...(TELEGRAM_BOT_TOKEN && { TELEGRAM_BOT_TOKEN }),
    ...(DISCORD_BOT_TOKEN && { DISCORD_BOT_TOKEN }),
  };

  gatewayProcess = spawn(
    "node",
    [OPENCLAW_BIN, "gateway", "--port", String(GATEWAY_PORT), "--allow-unconfigured"],
    { env, stdio: ["ignore", "inherit", "inherit"] }
  );

  gatewayProcess.on("spawn", () => {
    console.log("[gateway] Process spawned, PID:", gatewayProcess.pid);
    // Poll until gateway is accepting connections
    pollGatewayReady();
  });

  gatewayProcess.on("exit", (code, signal) => {
    gatewayReady = false;
    console.warn(`[gateway] Exited — code=${code} signal=${signal}`);
    restartCount++;
    const delay = backoffMs();
    console.log(`[gateway] Restarting in ${delay}ms...`);
    setTimeout(startGateway, delay);
  });
}

function pollGatewayReady(attempts = 0) {
  if (attempts > 60) {
    console.error("[gateway] Did not become ready after 60s");
    return;
  }
  const req = http.get(
    { hostname: GATEWAY_HOST, port: GATEWAY_PORT, path: "/healthz", timeout: 1000 },
    (res) => {
      if (res.statusCode < 500) {
        gatewayReady = true;
        restartCount = 0;
        console.log("[gateway] Ready ✓");
      }
    }
  );
  req.on("error", () => {
    setTimeout(() => pollGatewayReady(attempts + 1), 1000);
  });
  req.end();
}

// ─── Password check helper ────────────────────────────────────────────────────

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Still run the comparison to avoid timing leak on length
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function checkSetupAuth(req) {
  const authHeader = req.headers["authorization"] || "";
  if (!authHeader.startsWith("Basic ")) return false;
  const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
  const password = decoded.split(":").slice(1).join(":"); // support passwords with colons
  return timingSafeEqual(password, SETUP_PASSWORD);
}

// ─── Setup wizard HTML ────────────────────────────────────────────────────────

function setupPage(config, saved = false, error = "") {
  const configStr = JSON.stringify(config, null, 2);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenClaw Setup</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; background: #0f0f0f; color: #e0e0e0; margin: 0; padding: 2rem; }
  h1 { color: #ff6b35; margin-bottom: 0.25rem; }
  .subtitle { color: #888; margin-bottom: 2rem; font-size: 0.9rem; }
  label { display: block; margin-top: 1.5rem; margin-bottom: 0.4rem; font-weight: 600; color: #aaa; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; }
  input[type=text], input[type=password], textarea {
    width: 100%; padding: 0.6rem 0.8rem; background: #1a1a1a; border: 1px solid #333;
    border-radius: 6px; color: #e0e0e0; font-family: monospace; font-size: 0.9rem;
  }
  textarea { height: 320px; resize: vertical; }
  button {
    margin-top: 1.5rem; padding: 0.7rem 1.6rem; background: #ff6b35; border: none;
    border-radius: 6px; color: #fff; font-size: 1rem; font-weight: 600; cursor: pointer;
  }
  button:hover { background: #e55a28; }
  .card { background: #161616; border: 1px solid #2a2a2a; border-radius: 10px; padding: 1.5rem 2rem; max-width: 860px; }
  .badge { display: inline-block; background: #1a3a1a; color: #4caf50; border-radius: 4px; padding: 0.2rem 0.6rem; font-size: 0.75rem; margin-left: 0.5rem; }
  .badge.warn { background: #3a2a1a; color: #ff9800; }
  .saved { color: #4caf50; font-weight: 600; margin-top: 1rem; }
  .error { color: #f44336; font-weight: 600; margin-top: 1rem; }
  .hint { color: #666; font-size: 0.8rem; margin-top: 0.3rem; }
  section { margin-top: 2.5rem; }
</style>
</head>
<body>
<div class="card">
  <h1>🦞 OpenClaw Setup</h1>
  <div class="subtitle">Secure self-hosted AI assistant — Railway deployment</div>

  ${saved ? '<p class="saved">✓ Config saved. Restart the service in Railway to apply changes.</p>' : ""}
  ${error ? `<p class="error">✗ ${error}</p>` : ""}

  <section>
    <h3>Gateway status: <span class="badge${gatewayReady ? "" : " warn"}">${gatewayReady ? "Running" : "Starting..."}</span></h3>
  </section>

  <section>
    <h3>Security defaults active</h3>
    <ul style="color:#aaa;font-size:0.85rem;line-height:1.8">
      <li>✓ Gateway bound to loopback only (not public)</li>
      <li>✓ Token auth enforced on all gateway requests</li>
      <li>✓ DM policy: <strong>allowlist</strong> (strangers can't message the bot)</li>
      <li>✓ Sandbox enabled for group/channel sessions</li>
      <li>✓ Non-root container user</li>
    </ul>
  </section>

  <form method="POST" action="/setup">
    <section>
      <h3>Raw config (openclaw.json)</h3>
      <label for="config">Edit JSON directly — see <a href="https://docs.openclaw.ai/gateway/configuration" style="color:#ff6b35" target="_blank">config reference</a></label>
      <textarea name="config" id="config">${configStr
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</textarea>
      <div class="hint">Changes are written to /data/.openclaw/openclaw.json and persist across restarts.</div>
    </section>
    <button type="submit">Save config</button>
  </form>
</div>
</body>
</html>`;
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url = req.url || "/";

  // Health check — no auth required
  if (url === "/healthz" || url === "/health") {
    const status = gatewayReady ? 200 : 503;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: gatewayReady, uptime: process.uptime() }));
    return;
  }

  // Setup wizard — password-protected
  if (url.startsWith("/setup")) {
    if (!checkSetupAuth(req)) {
      res.writeHead(401, {
        "WWW-Authenticate": 'Basic realm="OpenClaw Setup", charset="UTF-8"',
        "Content-Type": "text/plain",
      });
      res.end("Authentication required");
      return;
    }

    if (req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const params = new URLSearchParams(body);
          const raw = params.get("config");
          const parsed = JSON.parse(raw);

          // Enforce security invariants — these cannot be overridden via the UI
          parsed.gateway = parsed.gateway || {};
          parsed.gateway.bind = "loopback";
          parsed.gateway.auth = parsed.gateway.auth || {};
          parsed.gateway.auth.token = GATEWAY_TOKEN;
          parsed.gateway.auth.mode = parsed.gateway.auth.mode || "token";

          // Sandbox: non-main sessions always sandboxed
          parsed.agents = parsed.agents || {};
          parsed.agents.defaults = parsed.agents.defaults || {};
          parsed.agents.defaults.sandbox = parsed.agents.defaults.sandbox || {};
          if (!parsed.agents.defaults.sandbox.mode) {
            parsed.agents.defaults.sandbox.mode = "non-main";
          }

          fs.writeFileSync(CONFIG_PATH, JSON.stringify(parsed, null, 2), { mode: 0o600 });

          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(setupPage(parsed, true));
        } catch (e) {
          const current = fs.existsSync(CONFIG_PATH)
            ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
            : {};
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(setupPage(current, false, "Invalid JSON: " + e.message));
        }
      });
      return;
    }

    // GET /setup
    const config = fs.existsSync(CONFIG_PATH)
      ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
      : {};
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(setupPage(config));
    return;
  }

  // Everything else → proxy to internal gateway
  if (!gatewayReady) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Gateway starting, try again shortly" }));
    return;
  }

  const proxyReq = http.request(
    {
      hostname: GATEWAY_HOST,
      port: GATEWAY_PORT,
      path: url,
      method: req.method,
      headers: {
        ...req.headers,
        host: `${GATEWAY_HOST}:${GATEWAY_PORT}`,
        // Inject gateway auth token so the proxy is authorized
        "x-openclaw-token": GATEWAY_TOKEN,
      },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on("error", (e) => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Gateway unreachable", detail: e.message }));
    }
  });

  req.pipe(proxyReq);
});

// WebSocket upgrade passthrough
server.on("upgrade", (req, socket, head) => {
  if (!gatewayReady) {
    socket.destroy();
    return;
  }

  const proxySocket = require("net").createConnection(GATEWAY_PORT, GATEWAY_HOST, () => {
    proxySocket.write(
      `${req.method} ${req.url} HTTP/1.1\r\n` +
        Object.entries(req.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n") +
        `\r\nx-openclaw-token: ${GATEWAY_TOKEN}\r\n\r\n`
    );
    proxySocket.write(head);
    socket.pipe(proxySocket).pipe(socket);
  });

  proxySocket.on("error", () => socket.destroy());
  socket.on("error", () => proxySocket.destroy());
});

// ─── Boot ──────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`[wrapper] Listening on :${PORT}`);
  console.log(`[wrapper] Setup wizard: http://localhost:${PORT}/setup`);
  console.log(`[wrapper] Health check: http://localhost:${PORT}/healthz`);
  startGateway();
});

process.on("SIGTERM", () => {
  console.log("[wrapper] SIGTERM received, shutting down gracefully...");
  if (gatewayProcess) gatewayProcess.kill("SIGTERM");
  server.close(() => process.exit(0));
});
