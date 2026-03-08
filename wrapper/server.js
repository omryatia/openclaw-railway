"use strict";

const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const net = require("net");

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || "8080", 10);
const GATEWAY_PORT = 18789;
const GATEWAY_HOST = "127.0.0.1";

const STATE_DIR = process.env.OPENCLAW_STATE_DIR || "/data/.openclaw";
const WORKSPACE_DIR = process.env.OPENCLAW_WORKSPACE_DIR || "/data/workspace";
const CONFIG_PATH = path.join(STATE_DIR, "openclaw.json");
const OPENCLAW_BIN = "/app/openclaw/dist/index.js";

const PUBLIC_DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN || "";
const PRIVATE_DOMAIN = process.env.RAILWAY_PRIVATE_DOMAIN || "";
const PUBLIC_URL = PUBLIC_DOMAIN ? `https://${PUBLIC_DOMAIN}` : "";

const OPENCLAW_GATEWAY_TOKEN =
  process.env.OPENCLAW_GATEWAY_TOKEN || process.env.GATEWAY_TOKEN || "";
const SETUP_PASSWORD = process.env.SETUP_PASSWORD || "";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN || "";

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

const configErrors = [];

if (!OPENCLAW_GATEWAY_TOKEN || OPENCLAW_GATEWAY_TOKEN.length < 32) {
  configErrors.push(
    "OPENCLAW_GATEWAY_TOKEN (or GATEWAY_TOKEN) is missing or too short (minimum 32 chars)."
  );
}

if (!SETUP_PASSWORD || SETUP_PASSWORD.length < 8) {
  configErrors.push("SETUP_PASSWORD is missing or too short (minimum 8 chars).");
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function fileExists(filePath) {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), { mode: 0o600 });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function isFirstRun() {
  return !fileExists(CONFIG_PATH);
}

function buildAllowedOrigins() {
  const origins = [];

  if (PUBLIC_URL) {
    origins.push(PUBLIC_URL);
  }

  if (PRIVATE_DOMAIN) {
    origins.push(`http://${PRIVATE_DOMAIN}:${PORT}`);
  }

  return origins.length > 0 ? origins : ["*"];
}

function defaultModelFromEnv() {
  if (OPENROUTER_API_KEY) return "openrouter/auto";
  if (ANTHROPIC_API_KEY) return "anthropic/claude-opus-4-6";
  if (OPENAI_API_KEY) return "openai/gpt-4o";
  return "";
}

function checkSetupAuth(req) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Basic ")) return false;

  const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
  const password = decoded.split(":").slice(1).join(":");

  const a = Buffer.from(password);
  const b = Buffer.from(SETUP_PASSWORD);

  if (a.length !== b.length) return false;

  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        reject(new Error("Request body too large."));
      }
    });

    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function getOriginalHost(req) {
  const forwardedHost = req.headers["x-forwarded-host"];
  if (typeof forwardedHost === "string" && forwardedHost.trim()) {
    return forwardedHost.split(",")[0].trim();
  }
  if (req.headers.host) {
    return req.headers.host;
  }
  if (PUBLIC_DOMAIN) {
    return PUBLIC_DOMAIN;
  }
  return `${GATEWAY_HOST}:${PORT}`;
}

function getOriginalProto(req) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  if (typeof forwardedProto === "string" && forwardedProto.trim()) {
    return forwardedProto.split(",")[0].trim();
  }

  const origin = req.headers.origin;
  if (typeof origin === "string") {
    try {
      return new URL(origin).protocol.replace(":", "");
    } catch {
      // ignore
    }
  }

  return PUBLIC_URL ? "https" : "http";
}

function getOriginalClientIp(req) {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "127.0.0.1";
}

function stripIncomingProxyHeaders(original) {
  const stripped = new Set([
    "x-forwarded-for",
    "x-forwarded-proto",
    "x-forwarded-host",
    "x-forwarded-port",
    "x-forwarded-scheme",
    "x-real-ip",
    "x-envoy-external-address",
    "forwarded",
    "cf-connecting-ip",
    "cf-ipcountry",
    "cf-ray",
    "cf-visitor",
    "true-client-ip",
  ]);

  const clean = {};
  for (const [key, value] of Object.entries(original)) {
    if (!stripped.has(key.toLowerCase())) {
      clean[key] = value;
    }
  }
  return clean;
}

function buildProxyHeaders(req, extra = {}) {
  const headers = stripIncomingProxyHeaders(req.headers);
  const host = getOriginalHost(req);
  const proto = getOriginalProto(req);
  const ip = getOriginalClientIp(req);

  headers.host = host;
  headers["x-forwarded-host"] = host;
  headers["x-forwarded-proto"] = proto;
  headers["x-forwarded-port"] = proto === "https" ? "443" : "80";
  headers["x-forwarded-for"] = ip;
  headers["x-real-ip"] = ip;
  headers["x-openclaw-token"] = OPENCLAW_GATEWAY_TOKEN;

  for (const [k, v] of Object.entries(extra)) {
    headers[k] = v;
  }

  return headers;
}

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

let normalizingFromWatch = false;

function syncChannelTokens(config) {
  config.channels = config.channels || {};

  if (TELEGRAM_BOT_TOKEN) {
    config.channels.telegram = config.channels.telegram || {};
    config.channels.telegram.enabled = true;
    config.channels.telegram.botToken = TELEGRAM_BOT_TOKEN;
    if (!config.channels.telegram.dmPolicy) {
      config.channels.telegram.dmPolicy = "pairing";
    }
    if (!config.channels.telegram.groupPolicy) {
      config.channels.telegram.groupPolicy = "disabled";
    }
  }

  if (DISCORD_BOT_TOKEN) {
    config.channels.discord = config.channels.discord || {};
    config.channels.discord.enabled = true;
    config.channels.discord.token = DISCORD_BOT_TOKEN;
    if (!config.channels.discord.dmPolicy) {
      config.channels.discord.dmPolicy = "pairing";
    }
  }

  if (SLACK_BOT_TOKEN || SLACK_APP_TOKEN) {
    config.channels.slack = config.channels.slack || {};
    config.channels.slack.enabled = true;
    if (SLACK_BOT_TOKEN) config.channels.slack.botToken = SLACK_BOT_TOKEN;
    if (SLACK_APP_TOKEN) config.channels.slack.appToken = SLACK_APP_TOKEN;
    if (!config.channels.slack.dmPolicy) {
      config.channels.slack.dmPolicy = "pairing";
    }
  }

  return config;
}

function createBaseConfig() {
  const model = defaultModelFromEnv();

  const config = {
    gateway: {
      mode: "local",
      bind: "loopback",
      port: GATEWAY_PORT,
      auth: {
        mode: "token",
        token: OPENCLAW_GATEWAY_TOKEN,
      },
      trustedProxies: ["127.0.0.1", "::1"],
      controlUi: {
        allowedOrigins: buildAllowedOrigins(),
        dangerouslyDisableDeviceAuth: true,
      },
    },
    agents: {
      defaults: {
        workspace: WORKSPACE_DIR,
        sandbox: {
          mode: "non-main",
        },
      },
    },
    commands: {
      native: "auto",
      nativeSkills: "auto",
      restart: true,
      ownerDisplay: "raw",
    },
    tools: {
      allow: ["read", "write", "edit", "web_search", "web_fetch", "apply_patch"],
      deny: ["exec"],
      elevated: {
        enabled: false,
      },
    },
    channels: {
      telegram: {
        dmPolicy: "pairing",
        groupPolicy: "disabled",
      },
      discord: {
        dmPolicy: "pairing",
      },
      slack: {
        dmPolicy: "pairing",
      },
      whatsapp: {},
    },
  };

  if (model) {
    config.agents.defaults.model = {
      primary: model,
    };
  }

  return syncChannelTokens(config);
}

function normalizeConfig(input) {
  const config = JSON.parse(JSON.stringify(input || {}));

  if (config.agent) {
    config.agents = config.agents || {};
    config.agents.defaults = config.agents.defaults || {};

    if (typeof config.agent.model === "string") {
      config.agents.defaults.model = config.agents.defaults.model || {};
      config.agents.defaults.model.primary = config.agent.model;
    }

    if (config.agent.workspace) {
      config.agents.defaults.workspace = config.agent.workspace;
    }

    delete config.agent;
  }

  config.agents = config.agents || {};
  config.agents.defaults = config.agents.defaults || {};
  config.agents.defaults.workspace =
    config.agents.defaults.workspace || WORKSPACE_DIR;
  config.agents.defaults.sandbox = config.agents.defaults.sandbox || {};
  config.agents.defaults.sandbox.mode =
    config.agents.defaults.sandbox.mode || "non-main";

  if (config.agents.defaults.thinking !== undefined) {
    delete config.agents.defaults.thinking;
  }
  if (config.agents.defaults.sandbox.tools !== undefined) {
    delete config.agents.defaults.sandbox.tools;
  }
  if (config.agents.defaults.sandbox.scope !== undefined) {
    delete config.agents.defaults.sandbox.scope;
  }

  if (!config.agents.defaults.model?.primary) {
    const fallbackModel = defaultModelFromEnv();
    if (fallbackModel) {
      config.agents.defaults.model = { primary: fallbackModel };
    }
  }

  config.commands = config.commands || {};
  if (config.commands.native === undefined) config.commands.native = "auto";
  if (config.commands.nativeSkills === undefined) config.commands.nativeSkills = "auto";
  if (config.commands.restart === undefined) config.commands.restart = true;
  if (config.commands.ownerDisplay === undefined) config.commands.ownerDisplay = "raw";

  if (config.auth !== undefined) {
    delete config.auth;
  }

  config.gateway = config.gateway || {};
  config.gateway.mode = "local";
  config.gateway.bind = "loopback";
  config.gateway.port = GATEWAY_PORT;
  config.gateway.auth = config.gateway.auth || {};
  config.gateway.auth.mode = "token";
  config.gateway.auth.token = OPENCLAW_GATEWAY_TOKEN;

  if (config.gateway.auth.allowInsecureAuth !== undefined) {
    delete config.gateway.auth.allowInsecureAuth;
  }
  if (config.gateway.tailscale !== undefined) {
    delete config.gateway.tailscale;
  }
  if (config.gateway.auth.allowTailscale !== undefined) {
    delete config.gateway.auth.allowTailscale;
  }

  config.gateway.controlUi = config.gateway.controlUi || {};
  config.gateway.controlUi.allowedOrigins = buildAllowedOrigins();
  config.gateway.controlUi.dangerouslyDisableDeviceAuth = true;
  config.gateway.trustedProxies = ["127.0.0.1", "::1"];

  if (!config.tools) {
    config.tools = {
      allow: ["read", "write", "edit", "web_search", "web_fetch", "apply_patch"],
      deny: ["exec"],
      elevated: {
        enabled: false,
      },
    };
  }

  syncChannelTokens(config);

  for (const channelName of ["telegram", "discord", "slack"]) {
    const channel = config.channels?.[channelName];
    if (
      channel &&
      channel.dmPolicy === "allowlist" &&
      (!Array.isArray(channel.allowFrom) || channel.allowFrom.length === 0)
    ) {
      channel.dmPolicy = "pairing";
    }
  }

  return config;
}

function ensureConfigFile() {
  ensureDir(STATE_DIR);
  ensureDir(WORKSPACE_DIR);

  if (!fileExists(CONFIG_PATH)) {
    writeJson(CONFIG_PATH, createBaseConfig());
    console.log("[config] Wrote initial config:", CONFIG_PATH);
    return;
  }

  const current = readJson(CONFIG_PATH, {});
  writeJson(CONFIG_PATH, normalizeConfig(current));
  console.log("[config] Normalized existing config:", CONFIG_PATH);
}

function readConfig() {
  return normalizeConfig(readJson(CONFIG_PATH, createBaseConfig()));
}

function saveConfig(nextConfig) {
  const normalized = normalizeConfig(nextConfig);
  writeJson(CONFIG_PATH, normalized);
  return normalized;
}

// -----------------------------------------------------------------------------
// Gateway process management
// -----------------------------------------------------------------------------

let gatewayProcess = null;
let gatewayReady = false;
let gatewayStarting = false;
let shutdownInProgress = false;
let configWatcherStarted = false;
let pendingRestartReason = null;
let restartCount = 0;

const MAX_RESTARTS = 10;
const RESTART_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

function gatewayEnv() {
  return {
    ...process.env,
    HOME: "/data",
    OPENCLAW_STATE_DIR: STATE_DIR,
    OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
    OPENCLAW_GATEWAY_BIND: "loopback",
    OPENCLAW_GATEWAY_PORT: String(GATEWAY_PORT),
    OPENCLAW_GATEWAY_TOKEN,

    ...(ANTHROPIC_API_KEY && { ANTHROPIC_API_KEY }),
    ...(OPENROUTER_API_KEY && { OPENROUTER_API_KEY }),
    ...(OPENAI_API_KEY && { OPENAI_API_KEY }),
    ...(TELEGRAM_BOT_TOKEN && { TELEGRAM_BOT_TOKEN }),
    ...(DISCORD_BOT_TOKEN && { DISCORD_BOT_TOKEN }),
    ...(SLACK_BOT_TOKEN && { SLACK_BOT_TOKEN }),
    ...(SLACK_APP_TOKEN && { SLACK_APP_TOKEN }),
  };
}

function runOpenClawCli(args) {
  return new Promise((resolve) => {
    const child = spawn("node", [OPENCLAW_BIN, ...args], {
      env: gatewayEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      resolve({
        code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });

    child.on("error", (err) => {
      resolve({
        code: 1,
        stdout: "",
        stderr: err.message,
      });
    });
  });
}

function scheduleRestart() {
  if (shutdownInProgress) return;

  restartCount += 1;
  if (restartCount > MAX_RESTARTS) {
    console.error("[gateway] Too many restarts. Giving up.");
    return;
  }

  const delay = RESTART_DELAYS[Math.min(restartCount - 1, RESTART_DELAYS.length - 1)];
  console.log(`[gateway] Restarting in ${delay}ms (${restartCount}/${MAX_RESTARTS})...`);

  setTimeout(() => {
    if (!shutdownInProgress) {
      startGateway();
    }
  }, delay);
}

function ensureConfigWatcher() {
  if (configWatcherStarted || !fileExists(CONFIG_PATH)) return;

  try {
    fs.watch(CONFIG_PATH, (event) => {
      if (event !== "change" || normalizingFromWatch) return;

      setTimeout(() => {
        try {
          const currentRaw = fs.readFileSync(CONFIG_PATH, "utf8");
          const normalized = JSON.stringify(normalizeConfig(JSON.parse(currentRaw)), null, 2);

          if (currentRaw !== normalized) {
            normalizingFromWatch = true;
            fs.writeFileSync(CONFIG_PATH, normalized, { mode: 0o600 });
          }
        } catch (err) {
          console.error("[config] fs.watch normalize failed:", err.message);
        } finally {
          setTimeout(() => {
            normalizingFromWatch = false;
          }, 300);
        }
      }, 200);
    });

    configWatcherStarted = true;
    console.log("[config] Watching", CONFIG_PATH, "for rewrites");
  } catch (err) {
    console.error("[config] Watch failed:", err.message);
  }
}

function pollGatewayReady(expectedChild, attempts = 0) {
  if (shutdownInProgress) return;
  if (gatewayProcess !== expectedChild) return;

  if (attempts > 90) {
    console.error("[gateway] Startup timed out after 90s");
    gatewayReady = false;
    gatewayStarting = false;
    pendingRestartReason = "startup timeout";

    try {
      expectedChild.kill("SIGTERM");
    } catch {}

    setTimeout(() => {
      if (gatewayProcess === expectedChild) {
        console.warn("[gateway] Force-killing stuck gateway after startup timeout");
        try {
          expectedChild.kill("SIGKILL");
        } catch {}
      }
    }, 5000);

    return;
  }

  const req = http.get(
    {
      hostname: GATEWAY_HOST,
      port: GATEWAY_PORT,
      path: "/healthz",
      timeout: 1000,
    },
    (res) => {
      if (gatewayProcess !== expectedChild) return;

      if (res.statusCode < 500) {
        gatewayReady = true;
        gatewayStarting = false;
        restartCount = 0;
        console.log("[gateway] Ready ✓");
        ensureConfigWatcher();
        return;
      }

      setTimeout(() => pollGatewayReady(expectedChild, attempts + 1), 1000);
    }
  );

  req.on("error", () => {
    setTimeout(() => pollGatewayReady(expectedChild, attempts + 1), 1000);
  });

  req.end();
}

function startGateway() {
  if (shutdownInProgress) return;
  if (configErrors.length > 0) return;
  if (gatewayStarting) {
    console.log("[gateway] Start already in progress, skipping.");
    return;
  }
  if (gatewayProcess) {
    console.log(`[gateway] Already running (PID ${gatewayProcess.pid}), skipping.`);
    return;
  }
  if (restartCount >= MAX_RESTARTS) {
    console.error("[gateway] Max restart count reached.");
    return;
  }

  gatewayStarting = true;
  gatewayReady = false;

  console.log(`[gateway] Starting (attempt ${restartCount + 1})...`);

  const child = spawn(
    "node",
    [OPENCLAW_BIN, "gateway", "--port", String(GATEWAY_PORT)],
    {
      env: gatewayEnv(),
      stdio: ["ignore", "inherit", "inherit"],
    }
  );

  gatewayProcess = child;

  child.on("spawn", () => {
    console.log("[gateway] PID:", child.pid);
    pollGatewayReady(child);
  });

  child.on("error", (err) => {
    if (gatewayProcess !== child) return;
    console.error("[gateway] Spawn error:", err.message);
    gatewayProcess = null;
    gatewayReady = false;
    gatewayStarting = false;
    scheduleRestart();
  });

  child.on("exit", (code, signal) => {
    if (gatewayProcess !== child) return;

    gatewayProcess = null;
    gatewayReady = false;
    gatewayStarting = false;

    if (shutdownInProgress) {
      console.log("[gateway] Stopped during shutdown.");
      return;
    }

    if (pendingRestartReason) {
      const reason = pendingRestartReason;
      pendingRestartReason = null;
      restartCount = 0;
      console.log(`[gateway] Restarting after requested change (${reason})...`);
      setTimeout(() => startGateway(), 500);
      return;
    }

    if (signal === "SIGTERM") {
      console.log("[gateway] Stopped (SIGTERM).");
      return;
    }

    console.warn(`[gateway] Exited unexpectedly (code=${code}, signal=${signal}).`);
    scheduleRestart();
  });
}

function restartGateway(reason = "config change") {
  if (shutdownInProgress) return;

  if (!gatewayProcess) {
    pendingRestartReason = null;
    restartCount = 0;
    console.log(`[gateway] Not running; starting fresh (${reason})...`);
    startGateway();
    return;
  }

  console.log(`[gateway] Restart requested: ${reason}`);
  pendingRestartReason = reason;

  const child = gatewayProcess;

  try {
    child.kill("SIGTERM");
  } catch {}

  setTimeout(() => {
    if (gatewayProcess === child) {
      console.warn("[gateway] Graceful restart timed out, force-killing child");
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  }, 5000);
}

// -----------------------------------------------------------------------------
// UI
// -----------------------------------------------------------------------------

function missingConfigPage() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>OpenClaw Setup Required</title>
  <style>
    body{font-family:system-ui,sans-serif;background:#0f0f0f;color:#eaeaea;padding:32px}
    .card{max-width:760px;margin:0 auto;background:#171717;border:1px solid #333;border-radius:12px;padding:24px}
    h1{margin-top:0}
    code{background:#222;padding:2px 6px;border-radius:4px}
    li{margin:8px 0}
  </style>
</head>
<body>
  <div class="card">
    <h1>OpenClaw wrapper is missing required variables</h1>
    <ul>
      ${configErrors.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}
    </ul>
    <p>Set them in Railway Variables and redeploy.</p>
  </div>
</body>
</html>`;
}

function renderSetupPage(config, opts = {}) {
  const saved = opts.saved ? `<p style="color:#4caf50">Saved.</p>` : "";
  const error = opts.error ? `<p style="color:#f44336">${escapeHtml(opts.error)}</p>` : "";

  const model = config.agents?.defaults?.model?.primary || "";
  const telegramAllowFrom = config.channels?.telegram?.allowFrom || [];

  const envStatus = [
    ["OPENCLAW_GATEWAY_TOKEN", !!OPENCLAW_GATEWAY_TOKEN],
    ["SETUP_PASSWORD", !!SETUP_PASSWORD],
    ["OPENROUTER_API_KEY", !!OPENROUTER_API_KEY],
    ["ANTHROPIC_API_KEY", !!ANTHROPIC_API_KEY],
    ["OPENAI_API_KEY", !!OPENAI_API_KEY],
    ["TELEGRAM_BOT_TOKEN", !!TELEGRAM_BOT_TOKEN],
    ["DISCORD_BOT_TOKEN", !!DISCORD_BOT_TOKEN],
    ["SLACK_BOT_TOKEN", !!SLACK_BOT_TOKEN],
    ["SLACK_APP_TOKEN", !!SLACK_APP_TOKEN],
  ];

  const configJson = escapeHtml(JSON.stringify(config, null, 2));

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>OpenClaw Railway Setup</title>
  <style>
    *{box-sizing:border-box}
    body{font-family:system-ui,sans-serif;background:#0f0f0f;color:#eaeaea;padding:24px;margin:0}
    .wrap{max-width:980px;margin:0 auto}
    .card{background:#171717;border:1px solid #2b2b2b;border-radius:12px;padding:20px;margin-bottom:18px}
    h1,h2{margin-top:0}
    .muted{color:#aaa}
    .ok{color:#4caf50}
    .warn{color:#ff9800}
    .bad{color:#f44336}
    input,select,textarea,button{
      width:100%;padding:10px 12px;border-radius:8px;border:1px solid #333;background:#111;color:#fff
    }
    textarea{min-height:320px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
    button{cursor:pointer;background:#ff6b35;border:none;margin-top:10px}
    button:hover{filter:brightness(1.05)}
    code{background:#222;padding:2px 6px;border-radius:4px}
    .row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
    .pill{display:inline-block;padding:4px 8px;border-radius:999px;background:#222;margin-right:8px}
    .list{line-height:1.8}
    a{color:#ff9566}
    pre{white-space:pre-wrap;background:#111;border:1px solid #333;padding:12px;border-radius:8px;margin-top:12px}
    @media (max-width: 700px){ .row{grid-template-columns:1fr} }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>OpenClaw Railway Setup</h1>
      <p class="muted">Gateway status:
        <span class="${gatewayReady ? "ok" : "warn"}">${gatewayReady ? "Running" : "Starting / Restarting"}</span>
      </p>
      <p class="muted">Public URL: ${PUBLIC_URL ? `<a href="${escapeHtml(PUBLIC_URL)}" target="_blank">${escapeHtml(PUBLIC_URL)}</a>` : "not set"}</p>
      <p class="muted">Private domain: ${PRIVATE_DOMAIN ? escapeHtml(PRIVATE_DOMAIN) : "not set"}</p>
      <p class="muted">Config: <code>${escapeHtml(CONFIG_PATH)}</code></p>
      ${
        PUBLIC_URL && gatewayReady
          ? `<p><a href="${escapeHtml(PUBLIC_URL)}/?token=${encodeURIComponent(
              OPENCLAW_GATEWAY_TOKEN
            )}" target="_blank">Open Control UI</a></p>`
          : ""
      }
      ${saved}
      ${error}
    </div>

    <div class="card">
      <h2>Browser device approval</h2>
      <p class="muted">
        If the Control UI shows <code>device identity required</code>, open the UI once,
        then come back here and approve the latest pending browser device request.
      </p>
      <form method="POST" action="/setup/device/approve-latest">
        <button type="submit">Approve latest browser device</button>
      </form>
      <form method="POST" action="/setup/device/list" style="margin-top:10px">
        <button type="submit">Show pending devices</button>
      </form>
      ${opts.deviceOutput ? `<pre>${escapeHtml(opts.deviceOutput)}</pre>` : ""}
    </div>

    <div class="card">
      <h2>Environment status</h2>
      <div class="list">
        ${envStatus
          .map(([name, ok]) => `<div><span class="${ok ? "ok" : "bad"}">${ok ? "✓" : "✗"}</span> <code>${name}</code></div>`)
          .join("")}
      </div>
    </div>

    <div class="card">
      <h2>Model</h2>
      <form method="POST" action="/setup/model">
        <select name="model">
          <option value="">Select model</option>
          <option value="openrouter/auto" ${model === "openrouter/auto" ? "selected" : ""}>openrouter/auto</option>
          <option value="openrouter/anthropic/claude-sonnet-4-5-20250929" ${model === "openrouter/anthropic/claude-sonnet-4-5-20250929" ? "selected" : ""}>openrouter/anthropic/claude-sonnet-4-5-20250929</option>
          <option value="openrouter/anthropic/claude-opus-4-6" ${model === "openrouter/anthropic/claude-opus-4-6" ? "selected" : ""}>openrouter/anthropic/claude-opus-4-6</option>
          <option value="openrouter/openai/gpt-4o" ${model === "openrouter/openai/gpt-4o" ? "selected" : ""}>openrouter/openai/gpt-4o</option>
          <option value="openrouter/google/gemini-2.5-pro" ${model === "openrouter/google/gemini-2.5-pro" ? "selected" : ""}>openrouter/google/gemini-2.5-pro</option>
          <option value="anthropic/claude-opus-4-6" ${model === "anthropic/claude-opus-4-6" ? "selected" : ""}>anthropic/claude-opus-4-6</option>
          <option value="anthropic/claude-sonnet-4-5-20250929" ${model === "anthropic/claude-sonnet-4-5-20250929" ? "selected" : ""}>anthropic/claude-sonnet-4-5-20250929</option>
          <option value="anthropic/claude-haiku-4-5-20251001" ${model === "anthropic/claude-haiku-4-5-20251001" ? "selected" : ""}>anthropic/claude-haiku-4-5-20251001</option>
          <option value="openai/gpt-4o" ${model === "openai/gpt-4o" ? "selected" : ""}>openai/gpt-4o</option>
          <option value="openai/gpt-4.1" ${model === "openai/gpt-4.1" ? "selected" : ""}>openai/gpt-4.1</option>
          <option value="openai/o3" ${model === "openai/o3" ? "selected" : ""}>openai/o3</option>
        </select>
        <button type="submit">Save model</button>
      </form>
    </div>

    <div class="card">
      <h2>Telegram allowlist</h2>
      <p class="muted">Current DM policy: <code>${escapeHtml(config.channels?.telegram?.dmPolicy || "pairing")}</code></p>
      <p class="muted">Approved IDs: ${
        telegramAllowFrom.length
          ? telegramAllowFrom.map((x) => `<span class="pill">${escapeHtml(x)}</span>`).join("")
          : "none"
      }</p>
      <form method="POST" action="/setup/allowfrom">
        <input type="hidden" name="channel" value="telegram">
        <input type="text" name="sender_id" placeholder="Telegram numeric user id">
        <button type="submit">Add Telegram user id</button>
      </form>
    </div>

    <div class="card">
      <h2>Tools</h2>
      <form method="POST" action="/setup/tools">
        <div class="row">
          <label><input type="checkbox" name="tools" value="read" ${(config.tools?.allow || []).includes("read") ? "checked" : ""}> read</label>
          <label><input type="checkbox" name="tools" value="write" ${(config.tools?.allow || []).includes("write") ? "checked" : ""}> write</label>
          <label><input type="checkbox" name="tools" value="edit" ${(config.tools?.allow || []).includes("edit") ? "checked" : ""}> edit</label>
          <label><input type="checkbox" name="tools" value="apply_patch" ${(config.tools?.allow || []).includes("apply_patch") ? "checked" : ""}> apply_patch</label>
          <label><input type="checkbox" name="tools" value="web_search" ${(config.tools?.allow || []).includes("web_search") ? "checked" : ""}> web_search</label>
          <label><input type="checkbox" name="tools" value="web_fetch" ${(config.tools?.allow || []).includes("web_fetch") ? "checked" : ""}> web_fetch</label>
          <label><input type="checkbox" name="tools" value="sessions_list" ${(config.tools?.allow || []).includes("sessions_list") ? "checked" : ""}> sessions_list</label>
          <label><input type="checkbox" name="tools" value="sessions_history" ${(config.tools?.allow || []).includes("sessions_history") ? "checked" : ""}> sessions_history</label>
          <label><input type="checkbox" name="tools" value="sessions_send" ${(config.tools?.allow || []).includes("sessions_send") ? "checked" : ""}> sessions_send</label>
          <label><input type="checkbox" name="tools" value="memory" ${(config.tools?.allow || []).includes("memory") ? "checked" : ""}> memory</label>
          <label><input type="checkbox" name="tools" value="browser" ${(config.tools?.allow || []).includes("browser") ? "checked" : ""}> browser</label>
          <label><input type="checkbox" name="tools" value="mcp" ${(config.tools?.allow || []).includes("mcp") ? "checked" : ""}> mcp</label>
          <label><input type="checkbox" name="tools" value="exec" ${(config.tools?.allow || []).includes("exec") ? "checked" : ""}> exec</label>
        </div>
        <label style="display:block;margin-top:12px">
          <input type="checkbox" name="approval_exec" value="true" ${config.tools?.elevated?.elevatedDefault === "off" ? "checked" : ""}>
          require approval for exec
        </label>
        <button type="submit">Save tools</button>
      </form>
    </div>

    <div class="card">
      <h2>Raw config</h2>
      <form method="POST" action="/setup/raw">
        <textarea name="config">${configJson}</textarea>
        <button type="submit">Save raw config</button>
      </form>
    </div>
  </div>
</body>
</html>`;
}

// -----------------------------------------------------------------------------
// Setup handlers
// -----------------------------------------------------------------------------

async function handleSetup(req, res) {
  if (!checkSetupAuth(req)) {
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="OpenClaw Setup"',
      "Content-Type": "text/plain; charset=utf-8",
    });
    res.end("Authentication required. Use any username and your SETUP_PASSWORD.");
    return;
  }

  if (req.method === "GET") {
    const config = readConfig();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderSetupPage(config));
    return;
  }

  const body = await parseBody(req);
  const params = new URLSearchParams(body);

  try {
    if (req.url === "/setup/device/list") {
      const result = await runOpenClawCli(["devices", "list"]);
      const config = readConfig();
      const output =
        result.stdout ||
        result.stderr ||
        `Command exited with code ${result.code}`;

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        renderSetupPage(config, {
          saved: result.code === 0,
          error: result.code === 0 ? "" : "Failed to list devices.",
          deviceOutput: output,
        })
      );
      return;
    }

    if (req.url === "/setup/device/approve-latest") {
      const result = await runOpenClawCli(["devices", "approve", "--latest"]);
      const config = readConfig();
      const output =
        result.stdout ||
        result.stderr ||
        `Command exited with code ${result.code}`;

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        renderSetupPage(config, {
          saved: result.code === 0,
          error: result.code === 0 ? "" : "Failed to approve latest device.",
          deviceOutput: output,
        })
      );
      return;
    }

    if (req.url === "/setup/model") {
      const model = (params.get("model") || "").trim();
      if (!model) throw new Error("Please select a model.");

      const config = readConfig();
      config.agents = config.agents || {};
      config.agents.defaults = config.agents.defaults || {};
      config.agents.defaults.model = { primary: model };

      const saved = saveConfig(config);
      restartGateway("model update");

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderSetupPage(saved, { saved: true }));
      return;
    }

    if (req.url === "/setup/allowfrom") {
      const channel = (params.get("channel") || "").trim();
      const senderId = (params.get("sender_id") || "").trim();

      if (!channel || !senderId) throw new Error("Please provide channel and sender id.");
      if (!/^\d+$/.test(senderId)) throw new Error("Sender ID must be numeric.");

      const config = readConfig();
      config.channels = config.channels || {};
      config.channels[channel] = config.channels[channel] || {};
      config.channels[channel].allowFrom = config.channels[channel].allowFrom || [];

      if (!config.channels[channel].allowFrom.includes(senderId)) {
        config.channels[channel].allowFrom.push(senderId);
      }

      if (config.channels[channel].dmPolicy === "pairing") {
        config.channels[channel].dmPolicy = "allowlist";
      }

      const saved = saveConfig(config);
      restartGateway("allowFrom update");

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderSetupPage(saved, { saved: true }));
      return;
    }

    if (req.url === "/setup/tools") {
      const selected = params.getAll("tools");
      const execApproval = params.get("approval_exec") === "true";

      const config = readConfig();
      config.tools = config.tools || {};
      config.tools.allow = selected.length
        ? selected
        : ["read", "write", "edit", "web_search", "web_fetch", "apply_patch"];

      if (!selected.includes("exec")) {
        config.tools.deny = ["exec"];
        config.tools.elevated = { enabled: false };
      } else if (execApproval) {
        config.tools.deny = [];
        config.tools.elevated = { enabled: true, elevatedDefault: "off" };
      } else {
        config.tools.deny = [];
        config.tools.elevated = { enabled: true, elevatedDefault: "on" };
      }

      const saved = saveConfig(config);
      restartGateway("tool policy update");

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderSetupPage(saved, { saved: true }));
      return;
    }

    if (req.url === "/setup/raw" || req.url === "/setup") {
      const raw = params.get("config");
      if (!raw) throw new Error("Missing config JSON.");

      const parsed = JSON.parse(raw);
      const saved = saveConfig(parsed);
      restartGateway("raw config update");

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderSetupPage(saved, { saved: true }));
      return;
    }

    throw new Error("Unsupported setup route.");
  } catch (err) {
    const config = readConfig();
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderSetupPage(config, { error: err.message || String(err) }));
  }
}

// -----------------------------------------------------------------------------
// HTTP + WS proxy
// -----------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = req.url || "/";

  if (url === "/healthz" || url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        gateway: gatewayReady,
        uptime: process.uptime(),
      })
    );
    return;
  }

  if (configErrors.length > 0 && !url.startsWith("/setup")) {
    res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
    res.end(missingConfigPage());
    return;
  }

  if ((url === "/" || url === "") && isFirstRun()) {
    res.writeHead(302, { Location: "/setup" });
    res.end();
    return;
  }

  if (url.startsWith("/setup")) {
    try {
      await handleSetup(req, res);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Setup handler failed: ${err.message}`);
    }
    return;
  }

  if (!gatewayReady) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Gateway starting, please wait..." }));
    return;
  }

  const parsedUrl = new URL(url, `http://${req.headers.host || "localhost"}`);
  const isPageLoad =
    !parsedUrl.searchParams.has("token") &&
    (req.headers.accept || "").includes("text/html");
  const isControlUiPath = url === "/" || url === "/openclaw" || url === "/openclaw/";

  if (isPageLoad && isControlUiPath && OPENCLAW_GATEWAY_TOKEN) {
    const sep = url.includes("?") ? "&" : "?";
    res.writeHead(302, {
      Location: `${url}${sep}token=${encodeURIComponent(OPENCLAW_GATEWAY_TOKEN)}`,
    });
    res.end();
    return;
  }

  const proxyPath = url.includes("token=")
    ? url
    : `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(
        OPENCLAW_GATEWAY_TOKEN
      )}`;

  const headers = buildProxyHeaders(req);

  const proxyReq = http.request(
    {
      hostname: GATEWAY_HOST,
      port: GATEWAY_PORT,
      path: proxyPath,
      method: req.method,
      headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  req.pipe(proxyReq);
});

server.on("upgrade", (req, socket, head) => {
  if (!gatewayReady) {
    socket.destroy();
    return;
  }

  socket.setKeepAlive(true, 20000);
  socket.setNoDelay(true);

  const proxy = net.createConnection(GATEWAY_PORT, GATEWAY_HOST, () => {
    proxy.setKeepAlive(true, 20000);
    proxy.setNoDelay(true);

    const headers = buildProxyHeaders(req);
    let wsUrl = req.url || "/";
    wsUrl += `${wsUrl.includes("?") ? "&" : "?"}token=${encodeURIComponent(
      OPENCLAW_GATEWAY_TOKEN
    )}`;

    proxy.write(
      `${req.method} ${wsUrl} HTTP/1.1\r\n` +
        Object.entries(headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n") +
        `\r\n\r\n`
    );

    proxy.write(head);
    socket.pipe(proxy).pipe(socket);
  });

  proxy.on("error", () => socket.destroy());
  socket.on("error", () => proxy.destroy());
});

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------

function boot() {
  ensureDir(STATE_DIR);
  ensureDir(WORKSPACE_DIR);
  ensureConfigFile();

  server.timeout = 0;
  server.keepAliveTimeout = 120000;
  server.headersTimeout = 120000;

  server.listen(PORT, () => {
    console.log(`[wrapper] Listening on :${PORT}`);
    console.log(`[wrapper] Public URL: ${PUBLIC_URL || "(not set)"}`);
    console.log(`[wrapper] State dir: ${STATE_DIR}`);
    console.log(`[wrapper] Workspace dir: ${WORKSPACE_DIR}`);
    console.log(`[wrapper] Config: ${CONFIG_PATH}`);

    if (configErrors.length > 0) {
      console.warn("[wrapper] Serving config error page until variables are fixed.");
      return;
    }

    startGateway();
  });
}

process.on("SIGTERM", () => {
  shutdownInProgress = true;
  pendingRestartReason = null;
  gatewayReady = false;
  gatewayStarting = false;

  const child = gatewayProcess;
  gatewayProcess = null;

  if (child) {
    try {
      child.kill("SIGTERM");
    } catch {}

    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, 5000);
  }

  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000);
});

boot();
