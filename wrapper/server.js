/**
 * OpenClaw Railway Wrapper
 * - Enforces GATEWAY_TOKEN and SETUP_PASSWORD
 * - Redirects to /setup on first visit (no config yet)
 * - Serves /setup wizard (password-gated)
 * - Dynamically sets controlUi.allowedOrigins from RAILWAY_PUBLIC_DOMAIN
 * - Spawns and manages the OpenClaw gateway
 * - Reverse-proxies all traffic to the internal gateway
 * - Exposes /healthz for Railway health checks
 */

"use strict";

const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const net = require("net");

// ─── Constants ────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "8080", 10);
const GATEWAY_PORT = 18789;
const GATEWAY_HOST = "127.0.0.1";
const OPENCLAW_DIR = process.env.OPENCLAW_DIR || "/data/.openclaw";
const WORKSPACE_DIR = process.env.OPENCLAW_WORKSPACE || "/data/workspace";
const CONFIG_PATH = path.join(OPENCLAW_DIR, "openclaw.json");
const DEFAULTS_PATH = "/app/openclaw-defaults.json";
const OPENCLAW_BIN = "/app/openclaw/dist/index.js";

// ─── Env vars ─────────────────────────────────────────────────────────────────

const GATEWAY_TOKEN       = process.env.GATEWAY_TOKEN || "";
const SETUP_PASSWORD      = process.env.SETUP_PASSWORD || "";
const ANTHROPIC_API_KEY   = process.env.ANTHROPIC_API_KEY || "";
const OPENROUTER_API_KEY  = process.env.OPENROUTER_API_KEY || "";
const OPENAI_API_KEY      = process.env.OPENAI_API_KEY || "";
const TELEGRAM_BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN || "";
const DISCORD_BOT_TOKEN   = process.env.DISCORD_BOT_TOKEN || "";

// Railway provides this automatically — use it for dynamic origin allowlist
const PUBLIC_DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN || "";
const PUBLIC_URL = PUBLIC_DOMAIN ? `https://${PUBLIC_DOMAIN}` : "";

// ─── Validation ───────────────────────────────────────────────────────────────

const configErrors = [];
if (!GATEWAY_TOKEN || GATEWAY_TOKEN.length < 32)
  configErrors.push("GATEWAY_TOKEN is missing or too short (min 32 chars).");
if (!SETUP_PASSWORD || SETUP_PASSWORD.length < 8)
  configErrors.push("SETUP_PASSWORD is missing or too short (min 8 chars).");
if (!ANTHROPIC_API_KEY && !OPENROUTER_API_KEY && !OPENAI_API_KEY)
  configErrors.push("No AI provider key set. Add ANTHROPIC_API_KEY, OPENROUTER_API_KEY, or OPENAI_API_KEY.");

if (configErrors.length > 0) {
  console.warn("[warn] Configuration issues:");
  configErrors.forEach(e => console.warn("  ✗", e));
}

// ─── First-run detection ──────────────────────────────────────────────────────

function isFirstRun() {
  return !fs.existsSync(CONFIG_PATH);
}

// ─── Directory bootstrap ──────────────────────────────────────────────────────

[OPENCLAW_DIR, WORKSPACE_DIR].forEach(dir => {
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (e) { console.error(`[boot] Cannot create ${dir}:`, e.message); }
});

// Write default config on first run, then always patch security-critical fields
try {
  let config;

  if (isFirstRun() && GATEWAY_TOKEN.length >= 32) {
    // First run — build from defaults
    config = JSON.parse(fs.readFileSync(DEFAULTS_PATH, "utf8"));
    if (ANTHROPIC_API_KEY)       config.agent = { ...config.agent, model: "anthropic/claude-opus-4-6" };
    else if (OPENROUTER_API_KEY) config.agent = { ...config.agent, model: "openrouter/auto" };
    else if (OPENAI_API_KEY)     config.agent = { ...config.agent, model: "openai/gpt-4o" };
    if (TELEGRAM_BOT_TOKEN)
      config.channels.telegram = { ...config.channels?.telegram, botToken: TELEGRAM_BOT_TOKEN, dmPolicy: "allowlist", allowFrom: [] };
    if (DISCORD_BOT_TOKEN)
      config.channels.discord = { ...config.channels?.discord, token: DISCORD_BOT_TOKEN, dmPolicy: "allowlist", allowFrom: [] };
    console.log("[boot] First run — writing default config →", CONFIG_PATH);
  } else if (fs.existsSync(CONFIG_PATH)) {
    // Existing config — load it
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  }

  if (config && GATEWAY_TOKEN.length >= 32) {
    // Always patch these on every boot — keeps them in sync with Railway variables
    config.gateway = config.gateway || {};
    config.gateway.bind = "loopback";
    config.gateway.auth = config.gateway.auth || {};
    config.gateway.auth.token = GATEWAY_TOKEN;
    config.gateway.controlUi = config.gateway.controlUi || {};
    config.gateway.controlUi.allowedOrigins = PUBLIC_URL ? [PUBLIC_URL] : ["*"];
    // Trust Railway's reverse proxy (sends real IP via X-Forwarded-For)
    config.gateway.trustedProxies = ["127.0.0.1", "::1"];

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
    console.log("[boot] Config patched — allowed origin:", config.gateway.controlUi.allowedOrigins[0]);
  }
} catch (e) {
  console.error("[boot] Failed to write config:", e.message);
}

// ─── Gateway management ───────────────────────────────────────────────────────

let gatewayProcess = null;
let gatewayReady = false;
let restartCount = 0;
const MAX_RESTARTS = 10;
const RESTART_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

function startGateway() {
  if (configErrors.some(e => e.includes("GATEWAY_TOKEN"))) return;
  if (restartCount >= MAX_RESTARTS) { console.error("[gateway] Too many restarts."); return; }

  console.log(`[gateway] Starting (attempt ${restartCount + 1})...`);
  gatewayReady = false;

  const env = {
    ...process.env,
    HOME: OPENCLAW_DIR,
    OPENCLAW_DIR,
    OPENCLAW_GATEWAY_BIND: "loopback",
    OPENCLAW_GATEWAY_PORT: String(GATEWAY_PORT),
    OPENCLAW_GATEWAY_TOKEN: GATEWAY_TOKEN,
    ...(ANTHROPIC_API_KEY  && { ANTHROPIC_API_KEY }),
    ...(OPENROUTER_API_KEY && { OPENROUTER_API_KEY }),
    ...(OPENAI_API_KEY     && { OPENAI_API_KEY }),
    ...(TELEGRAM_BOT_TOKEN && { TELEGRAM_BOT_TOKEN }),
    ...(DISCORD_BOT_TOKEN  && { DISCORD_BOT_TOKEN }),
  };

  gatewayProcess = spawn("node", [OPENCLAW_BIN, "gateway", "--port", String(GATEWAY_PORT), "--allow-unconfigured"], {
    env, stdio: ["ignore", "inherit", "inherit"],
  });

  gatewayProcess.on("spawn", () => { console.log("[gateway] PID:", gatewayProcess.pid); pollGatewayReady(); });
  gatewayProcess.on("exit", (code, signal) => {
    gatewayReady = false;
    restartCount++;
    const delay = RESTART_DELAYS[Math.min(restartCount - 1, RESTART_DELAYS.length - 1)];
    console.warn(`[gateway] Exited code=${code}, restarting in ${delay}ms...`);
    setTimeout(startGateway, delay);
  });
}

function pollGatewayReady(attempts = 0) {
  if (attempts > 90) { console.error("[gateway] Never became ready"); return; }
  const req = http.get({ hostname: GATEWAY_HOST, port: GATEWAY_PORT, path: "/healthz", timeout: 1000 }, res => {
    if (res.statusCode < 500) {
      gatewayReady = true;
      restartCount = 0;
      console.log("[gateway] Ready ✓");
    }
  });
  req.on("error", () => setTimeout(() => pollGatewayReady(attempts + 1), 1000));
  req.end();
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

function checkSetupAuth(req) {
  const auth = req.headers["authorization"] || "";
  if (!auth.startsWith("Basic ")) return false;
  const password = Buffer.from(auth.slice(6), "base64").toString("utf8").split(":").slice(1).join(":");
  const a = Buffer.from(password), b = Buffer.from(SETUP_PASSWORD);
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

// ─── Pages ────────────────────────────────────────────────────────────────────

function missingConfigPage() {
  return `<!DOCTYPE html><html lang="en">
<head><meta charset="utf-8"><title>OpenClaw — Setup Required</title>
<style>body{font-family:system-ui,sans-serif;background:#0f0f0f;color:#e0e0e0;padding:2rem}
.card{background:#161616;border:1px solid #f44336;border-radius:10px;padding:2rem;max-width:640px}
h1{color:#ff6b35}code{background:#1a1a1a;padding:.2rem .5rem;border-radius:4px}
li{margin:.5rem 0}.err{color:#f44336}</style></head>
<body><div class="card">
<h1>🦞 Configuration Required</h1>
<p>Set these Railway Variables, then redeploy:</p>
<ul>${configErrors.map(e => `<li class="err">✗ ${e}</li>`).join("")}</ul>
<p>Railway → your service → Variables → Raw Editor</p>
</div></body></html>`;
}

function setupPage(config, saved = false, error = "") {
  const configStr = JSON.stringify(config, null, 2)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!DOCTYPE html><html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenClaw Setup</title>
<style>
*{box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:#0f0f0f;color:#e0e0e0;margin:0;padding:2rem}
h1{color:#ff6b35;margin-bottom:.25rem}
.subtitle{color:#888;margin-bottom:2rem;font-size:.9rem}
label{display:block;margin-top:1.5rem;margin-bottom:.4rem;font-weight:600;color:#aaa;font-size:.85rem;text-transform:uppercase;letter-spacing:.05em}
textarea{width:100%;height:380px;padding:.6rem .8rem;background:#1a1a1a;border:1px solid #333;border-radius:6px;color:#e0e0e0;font-family:monospace;font-size:.85rem;resize:vertical}
button{margin-top:1.5rem;padding:.7rem 1.6rem;background:#ff6b35;border:none;border-radius:6px;color:#fff;font-size:1rem;font-weight:600;cursor:pointer}
button:hover{background:#e55a28}
.card{background:#161616;border:1px solid #2a2a2a;border-radius:10px;padding:1.5rem 2rem;max-width:860px}
.badge{display:inline-block;border-radius:4px;padding:.2rem .6rem;font-size:.75rem;margin-left:.5rem}
.ok{background:#1a3a1a;color:#4caf50}.warn{background:#3a2a1a;color:#ff9800}
.saved{color:#4caf50;font-weight:600;margin-top:1rem}
.error{color:#f44336;font-weight:600;margin-top:1rem}
.hint{color:#666;font-size:.8rem;margin-top:.3rem}
.domain{color:#4caf50;font-size:.8rem;margin-top:.5rem}
ul{color:#aaa;font-size:.85rem;line-height:1.8}
a{color:#ff6b35}
</style></head>
<body><div class="card">
<h1>🦞 OpenClaw Setup</h1>
<div class="subtitle">Secure self-hosted AI assistant — Railway deployment</div>
${saved ? '<p class="saved">✓ Config saved. Restart the service in Railway to apply changes.</p>' : ""}
${error ? `<p class="error">✗ ${error}</p>` : ""}
<h3>Gateway: <span class="badge ${gatewayReady ? "ok" : "warn"}">${gatewayReady ? "Running ✓" : "Starting..."}</span></h3>
${PUBLIC_URL ? `<div class="domain">🌐 Public URL: <a href="${PUBLIC_URL}" target="_blank">${PUBLIC_URL}</a></div>` : ""}
<h3>Security defaults</h3>
<ul>
  <li>✓ Gateway bound to loopback only</li>
  <li>✓ Token auth enforced</li>
  <li>✓ DM policy: <strong>allowlist</strong></li>
  <li>✓ Sandbox for group/channel sessions</li>
  <li>✓ Allowed origin: <strong>${PUBLIC_URL || "*"}</strong></li>
</ul>
<form method="POST" action="/setup">
  <label for="config">openclaw.json — <a href="https://docs.openclaw.ai/gateway/configuration" target="_blank">config reference ↗</a></label>
  <textarea name="config" id="config">${configStr}</textarea>
  <div class="hint">Saved to /data/.openclaw/openclaw.json — persists across restarts and redeploys.</div>
  <button type="submit">Save config</button>
</form>
</div></body></html>`;
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url = req.url || "/";

  // Health — always 200, never blocked
  if (url === "/healthz" || url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, gateway: gatewayReady, uptime: process.uptime() }));
    return;
  }

  // Config errors — show error page
  if (configErrors.length > 0 && !url.startsWith("/setup")) {
    res.writeHead(503, { "Content-Type": "text/html" });
    res.end(missingConfigPage());
    return;
  }

  // First run — redirect root to /setup
  if ((url === "/" || url === "") && isFirstRun()) {
    res.writeHead(302, { Location: "/setup" });
    res.end();
    return;
  }

  // Setup wizard
  if (url.startsWith("/setup")) {
    if (!checkSetupAuth(req)) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="OpenClaw Setup"', "Content-Type": "text/plain" });
      res.end("Authentication required — use any username and your SETUP_PASSWORD");
      return;
    }

    if (req.method === "POST") {
      let body = "";
      req.on("data", chunk => (body += chunk));
      req.on("end", () => {
        try {
          const parsed = JSON.parse(new URLSearchParams(body).get("config"));
          // Enforce security invariants — cannot be overridden via UI
          parsed.gateway = parsed.gateway || {};
          parsed.gateway.bind = "loopback";
          parsed.gateway.auth = parsed.gateway.auth || {};
          parsed.gateway.auth.token = GATEWAY_TOKEN;
          // Keep the dynamic origin
          parsed.gateway.controlUi = parsed.gateway.controlUi || {};
          if (!parsed.gateway.controlUi.allowedOrigins) {
            parsed.gateway.controlUi.allowedOrigins = PUBLIC_URL ? [PUBLIC_URL] : ["*"];
          }
          parsed.agents = parsed.agents || {};
          parsed.agents.defaults = parsed.agents.defaults || {};
          parsed.agents.defaults.sandbox = parsed.agents.defaults.sandbox || {};
          if (!parsed.agents.defaults.sandbox.mode) parsed.agents.defaults.sandbox.mode = "non-main";

          fs.writeFileSync(CONFIG_PATH, JSON.stringify(parsed, null, 2), { mode: 0o600 });
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(setupPage(parsed, true));
        } catch (e) {
          const current = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) : {};
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(setupPage(current, false, "Invalid JSON: " + e.message));
        }
      });
      return;
    }

    const config = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) : {};
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(setupPage(config));
    return;
  }

  // Proxy to gateway
  if (!gatewayReady) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Gateway starting, please wait..." }));
    return;
  }

  const proxyReq = http.request(
    { hostname: GATEWAY_HOST, port: GATEWAY_PORT, path: url, method: req.method,
      headers: { ...req.headers, host: `${GATEWAY_HOST}:${GATEWAY_PORT}`, "x-openclaw-token": GATEWAY_TOKEN } },
    proxyRes => { res.writeHead(proxyRes.statusCode, proxyRes.headers); proxyRes.pipe(res); }
  );
  proxyReq.on("error", e => {
    if (!res.headersSent) { res.writeHead(502); res.end(JSON.stringify({ error: e.message })); }
  });
  req.pipe(proxyReq);
});

// WebSocket passthrough
server.on("upgrade", (req, socket, head) => {
  if (!gatewayReady) { socket.destroy(); return; }
  const proxy = net.createConnection(GATEWAY_PORT, GATEWAY_HOST, () => {
    proxy.write(
      `${req.method} ${req.url} HTTP/1.1\r\n` +
      Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n") +
      `\r\nx-openclaw-token: ${GATEWAY_TOKEN}\r\n\r\n`
    );
    proxy.write(head);
    socket.pipe(proxy).pipe(socket);
  });
  proxy.on("error", () => socket.destroy());
  socket.on("error", () => proxy.destroy());
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`[wrapper] Listening on :${PORT}`);
  console.log(`[wrapper] Public URL: ${PUBLIC_URL || "(not set)"}`);
  console.log(`[wrapper] First run: ${isFirstRun()}`);
  if (configErrors.length > 0) {
    console.warn("[wrapper] Serving config-error page until variables are set.");
  } else {
    startGateway();
  }
});

process.on("SIGTERM", () => {
  if (gatewayProcess) gatewayProcess.kill("SIGTERM");
  server.close(() => process.exit(0));
});
