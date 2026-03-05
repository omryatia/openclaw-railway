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

// FIX #1 (CRITICAL — ROOT CAUSE): Config path mismatch.
//
// OLD CODE:
//   OPENCLAW_DIR = "/data/.openclaw"
//   CONFIG_PATH  = "/data/.openclaw/openclaw.json"
//   Gateway env:  HOME = "/data/.openclaw"   (HOME was set to OPENCLAW_DIR)
//
// PROBLEM: OpenClaw resolves state dir as $OPENCLAW_STATE_DIR or $HOME/.openclaw.
// With HOME=/data/.openclaw, the gateway looked for config at:
//   /data/.openclaw/.openclaw/openclaw.json   ← NESTED, DOESN'T EXIST
// But the wrapper wrote config to:
//   /data/.openclaw/openclaw.json             ← CORRECT PATH
//
// RESULT: Gateway started with --allow-unconfigured (empty config),
// meaning NO trustedProxies, NO auth token, NO allowedOrigins.
// Every WebSocket connection was rejected with code 4008 "connect failed".
//
// FIX: Use OPENCLAW_STATE_DIR (the standard OpenClaw env var) AND
// set HOME=/data so $HOME/.openclaw resolves to /data/.openclaw.
const STATE_DIR = process.env.OPENCLAW_STATE_DIR || "/data/.openclaw";
const WORKSPACE_DIR = process.env.OPENCLAW_WORKSPACE_DIR || "/data/workspace";
const CONFIG_PATH = path.join(STATE_DIR, "openclaw.json");
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
const TAILSCALE_AUTH_KEY  = process.env.TAILSCALE_AUTH_KEY || "";

// Railway provides this automatically — use it for dynamic origin allowlist
const PUBLIC_DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN || "";
const PUBLIC_URL = PUBLIC_DOMAIN ? `https://${PUBLIC_DOMAIN}` : "";

// FIX #2 (CRITICAL): Strip proxy headers before forwarding to gateway.
//
// OLD CODE: `const headers = { ...req.headers }` — forwarded ALL headers
// including x-forwarded-for, x-forwarded-proto, etc. from Railway's edge.
//
// PROBLEM: The gateway saw proxy headers but the source IP (127.0.0.1) wasn't
// recognized as a trusted proxy (because of FIX #1 — config wasn't loaded).
// Even WITH the config loaded, forwarding Railway's headers creates confusion
// since the wrapper IS the trusted proxy — it should present clean requests.
//
// The "[ws] Proxy headers detected from untrusted address" log message was
// the gateway complaining about these leaked headers.
const STRIPPED_HEADERS = new Set([
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

function stripProxyHeaders(original) {
  const clean = {};
  for (const [key, value] of Object.entries(original)) {
    if (!STRIPPED_HEADERS.has(key.toLowerCase())) {
      clean[key] = value;
    }
  }
  return clean;
}

// ─── Validation ───────────────────────────────────────────────────────────────

const configErrors = [];
if (!GATEWAY_TOKEN || GATEWAY_TOKEN.length < 32)
  configErrors.push("GATEWAY_TOKEN is missing or too short (min 32 chars).");
if (!SETUP_PASSWORD || SETUP_PASSWORD.length < 8)
  configErrors.push("SETUP_PASSWORD is missing or too short (min 8 chars).");
// Note: AI provider keys are no longer required at boot — users set them via /setup wizard

if (configErrors.length > 0) {
  console.warn("[warn] Configuration issues:");
  configErrors.forEach(e => console.warn("  ✗", e));
}

// ─── First-run detection ──────────────────────────────────────────────────────

function isFirstRun() {
  return !fs.existsSync(CONFIG_PATH);
}

// ─── Directory bootstrap ──────────────────────────────────────────────────────

[STATE_DIR, WORKSPACE_DIR].forEach(dir => {
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (e) { console.error(`[boot] Cannot create ${dir}:`, e.message); }
});

// ─── Config patching ──────────────────────────────────────────────────────────
// Patch security-critical config fields — called after every config write by OpenClaw.
// OpenClaw rewrites openclaw.json on startup and during doctor/wizard runs, stripping
// custom fields like controlUi.allowedOrigins and trustedProxies each time.
// We use fs.watch to detect every rewrite and re-apply our patch within milliseconds.
//
// FIX #5: _patching and patchConfig MUST be declared BEFORE the boot-time code
// that calls patchConfig("pre-start"). `let` has a temporal dead zone — accessing
// it before the declaration line throws "Cannot access '_patching' before initialization".
// The old code had the boot block at ~line 137 and `let _patching` at ~line 161.

let _patching = false; // prevent write→watch→patch→write loop

function patchConfig(reason) {
  if (_patching) return false;
  _patching = true;
  let didPatch = false;
  try {
    if (!fs.existsSync(CONFIG_PATH)) return;
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const config = JSON.parse(raw);

    // FIX #6: Migrate deprecated `agent` → `agents.defaults` format.
    // Current OpenClaw versions reject the old `agent.model` string format.
    // Gateway exits with code=1: "agent.model string was replaced by
    // agents.defaults.model.primary/fallbacks".
    let didMigrate = false;
    if (config.agent) {
      config.agents = config.agents || {};
      config.agents.defaults = config.agents.defaults || {};
      if (config.agent.model && typeof config.agent.model === "string") {
        config.agents.defaults.model = config.agents.defaults.model || {};
        config.agents.defaults.model.primary = config.agent.model;
      }
      // Only merge workspace — other agent.* fields (thinking, etc.) are not
      // valid under agents.defaults and OpenClaw rejects them as unknown keys
      if (config.agent.workspace) {
        config.agents.defaults.workspace = config.agent.workspace;
      }
      delete config.agent;
      didMigrate = true;
      console.log(`[config] Migrated deprecated agent → agents.defaults`);
    }

    // Clean up unknown config keys that OpenClaw rejects
    if (config.agents?.defaults?.thinking !== undefined) {
      delete config.agents.defaults.thinking;
      didMigrate = true;
    }
    if (config.agents?.defaults?.sandbox?.tools) {
      delete config.agents.defaults.sandbox.tools;
      didMigrate = true;
    }
    if (config.agents?.defaults?.sandbox?.scope) {
      delete config.agents.defaults.sandbox.scope;
      didMigrate = true;
    }
    // Clean invalid keys that OpenClaw rejects
    if (config.gateway?.auth?.allowInsecureAuth !== undefined) {
      delete config.gateway.auth.allowInsecureAuth;
      didMigrate = true;
    }
    // Remove auth section from config — API keys belong in Railway env vars only
    if (config.auth) {
      delete config.auth;
      didMigrate = true;
      console.log("[config] Removed auth section from config (keys should be in Railway env vars)");
    }

    // FIX #8: dmPolicy "allowlist" with empty allowFrom is a fatal config error.
    // Switch to "pairing" when no IDs are configured — users can pair interactively
    // then switch to allowlist later via /setup once they have their sender IDs.
    for (const ch of ["telegram", "discord", "slack"]) {
      const channel = config.channels?.[ch];
      if (channel?.dmPolicy === "allowlist" && (!channel.allowFrom || channel.allowFrom.length === 0)) {
        channel.dmPolicy = "pairing";
        didMigrate = true;
        console.log(`[config] ${ch}: switched dmPolicy from allowlist → pairing (no allowFrom IDs)`);
      }
    }

    // Check if security patch is actually needed before writing
    const origins = config.gateway?.controlUi?.allowedOrigins || [];
    const expectedOrigin = PUBLIC_URL || "*";
    const alreadyPatched =
      config.gateway?.bind === "loopback" &&
      config.gateway?.auth?.token === GATEWAY_TOKEN &&
      config.gateway?.trustedProxies?.includes("127.0.0.1") &&
      (origins[0] === expectedOrigin || origins[0] === PUBLIC_URL);

    if (alreadyPatched && !didMigrate) return false;

    config.gateway = config.gateway || {};
    config.gateway.bind = "loopback";
    config.gateway.auth = config.gateway.auth || {};
    config.gateway.auth.token = GATEWAY_TOKEN;
    config.gateway.controlUi = config.gateway.controlUi || {};
    config.gateway.controlUi.allowedOrigins = PUBLIC_URL ? [PUBLIC_URL] : ["*"];
    // FIX #11: Disable device identity auth for the Control UI.
    // Behind Railway's proxy, the wrapper already handles access control
    // (SETUP_PASSWORD). Device pairing uses WebCrypto and requires an
    // interactive approval step that blocks the WS connection even after
    // token auth succeeds (code 4008 "connect failed").
    config.gateway.controlUi.dangerouslyDisableDeviceAuth = true;
    config.gateway.trustedProxies = ["127.0.0.1", "::1"];
    if (TAILSCALE_AUTH_KEY) {
      config.gateway.tailscale = { mode: "serve", authKey: TAILSCALE_AUTH_KEY };
      config.gateway.auth.allowTailscale = true;
    }

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
    console.log(`[config] Patched (${reason || "manual"}) — origin: ${config.gateway.controlUi.allowedOrigins[0]}`);
    didPatch = true;
  } catch (e) {
    console.error("[config] Patch failed:", e.message);
  } finally {
    setTimeout(() => { _patching = false; }, 500);
  }
  return didPatch;
}

// ─── Boot-time config ─────────────────────────────────────────────────────────
// 1. First run: write defaults using the NEW config schema
// 2. Every boot: patch security-critical fields + migrate legacy keys
try {
  if (isFirstRun() && GATEWAY_TOKEN.length >= 32) {
    const defaults = JSON.parse(fs.readFileSync(DEFAULTS_PATH, "utf8"));

    defaults.agents = defaults.agents || {};
    defaults.agents.defaults = defaults.agents.defaults || {};
    defaults.agents.defaults.model = defaults.agents.defaults.model || {};
    delete defaults.agent;

    // Set model based on which env var key is present (keys stay in env vars, not config)
    if (ANTHROPIC_API_KEY)       defaults.agents.defaults.model.primary = "anthropic/claude-opus-4-6";
    else if (OPENROUTER_API_KEY) defaults.agents.defaults.model.primary = "openrouter/auto";
    else if (OPENAI_API_KEY)     defaults.agents.defaults.model.primary = "openai/gpt-4o";
    // No key? User will pick model in /setup wizard after adding a key in Railway

    if (TELEGRAM_BOT_TOKEN)
      defaults.channels.telegram = { ...defaults.channels?.telegram, botToken: TELEGRAM_BOT_TOKEN, dmPolicy: "pairing" };
    if (DISCORD_BOT_TOKEN)
      defaults.channels.discord = { ...defaults.channels?.discord, token: DISCORD_BOT_TOKEN, dmPolicy: "pairing" };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaults, null, 2), { mode: 0o600 });
    console.log("[boot] First run — wrote default config →", CONFIG_PATH);
  }
  // Always apply security patch + migration before gateway starts
  patchConfig("pre-start");
} catch (e) {
  console.error("[boot] Failed to write config:", e.message);
}

// Watch config file — re-patch every time OpenClaw rewrites it
function watchConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    setTimeout(watchConfig, 2000);
    return;
  }
  try {
    fs.watch(CONFIG_PATH, (event) => {
      if (event === "change") {
        setTimeout(() => patchConfig("fs.watch"), 200);
      }
    });
    console.log("[config] Watching", CONFIG_PATH, "for OpenClaw rewrites");
    patchConfig("initial");
  } catch (e) {
    console.error("[config] Watch failed:", e.message);
  }
}

// ─── Gateway management ───────────────────────────────────────────────────────

let gatewayProcess = null;
let gatewayReady = false;
let restartCount = 0;
let configPatchRestartPending = false;
const MAX_RESTARTS = 10;
const RESTART_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

function startGateway() {
  if (configErrors.some(e => e.includes("GATEWAY_TOKEN"))) return;
  if (restartCount >= MAX_RESTARTS) { console.error("[gateway] Too many restarts."); return; }

  console.log(`[gateway] Starting (attempt ${restartCount + 1})...`);
  gatewayReady = false;

  // FIX #1 continued: correct env vars for the gateway subprocess.
  // HOME=/data → gateway resolves $HOME/.openclaw = /data/.openclaw ✓
  // OPENCLAW_STATE_DIR is the explicit override (belt + suspenders)
  // OPENCLAW_WORKSPACE_DIR (not OPENCLAW_WORKSPACE) is the standard var
  const env = {
    ...process.env,
    HOME: "/data",
    OPENCLAW_STATE_DIR: STATE_DIR,
    OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
    OPENCLAW_GATEWAY_BIND: "loopback",
    OPENCLAW_GATEWAY_PORT: String(GATEWAY_PORT),
    OPENCLAW_GATEWAY_TOKEN: GATEWAY_TOKEN,
    ...(ANTHROPIC_API_KEY && { ANTHROPIC_API_KEY }),
    ...(OPENROUTER_API_KEY && { OPENROUTER_API_KEY }),
    ...(OPENAI_API_KEY && { OPENAI_API_KEY }),
    ...(TELEGRAM_BOT_TOKEN && { TELEGRAM_BOT_TOKEN }),
    ...(DISCORD_BOT_TOKEN && { DISCORD_BOT_TOKEN }),
  };

  gatewayProcess = spawn("node", [OPENCLAW_BIN, "gateway", "--port", String(GATEWAY_PORT), "--allow-unconfigured"], {
    env, stdio: ["ignore", "inherit", "inherit"],
  });

  gatewayProcess.on("spawn", () => { console.log("[gateway] PID:", gatewayProcess.pid); pollGatewayReady(); });
  gatewayProcess.on("exit", (code, signal) => {
    gatewayReady = false;
    if (configPatchRestartPending) {
      configPatchRestartPending = false;
      console.log("[gateway] Config-patch restart — restarting immediately...");
      setTimeout(startGateway, 500);
    } else {
      restartCount++;
      const delay = RESTART_DELAYS[Math.min(restartCount - 1, RESTART_DELAYS.length - 1)];
      console.warn(`[gateway] Exited code=${code}, restarting in ${delay}ms...`);
      setTimeout(startGateway, delay);
    }
  });
}

function pollGatewayReady(attempts = 0) {
  if (attempts > 90) { console.error("[gateway] Never became ready"); return; }
  const req = http.get({ hostname: GATEWAY_HOST, port: GATEWAY_PORT, path: "/healthz", timeout: 1000 }, res => {
    if (res.statusCode < 500) {
      gatewayReady = true;
      restartCount = 0;
      console.log("[gateway] Ready ✓");
      watchConfig();
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
  // Detect which provider keys are set via Railway env vars
  const providers = [
    { id: "anthropic", name: "Anthropic (Claude)", envVar: "ANTHROPIC_API_KEY", hasKey: !!ANTHROPIC_API_KEY },
    { id: "openrouter", name: "OpenRouter (multi-provider)", envVar: "OPENROUTER_API_KEY", hasKey: !!OPENROUTER_API_KEY },
    { id: "openai", name: "OpenAI (GPT)", envVar: "OPENAI_API_KEY", hasKey: !!OPENAI_API_KEY },
  ];
  const activeProvider = providers.find(p => p.hasKey);
  const currentModel = config.agents?.defaults?.model?.primary || "";
  const hasAnyKey = providers.some(p => p.hasKey);

  const configStr = JSON.stringify(config, null, 2)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  return `<!DOCTYPE html><html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenClaw Setup</title>
<style>
*{box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:#0f0f0f;color:#e0e0e0;margin:0;padding:2rem}
h1{color:#ff6b35;margin-bottom:.25rem}
h2{color:#e0e0e0;font-size:1.1rem;margin-top:1.5rem;margin-bottom:.8rem;border-bottom:1px solid #2a2a2a;padding-bottom:.4rem}
.subtitle{color:#888;margin-bottom:1.5rem;font-size:.9rem}
label{display:block;margin-top:1rem;margin-bottom:.4rem;font-weight:600;color:#aaa;font-size:.85rem;text-transform:uppercase;letter-spacing:.05em}
select,textarea{width:100%;padding:.6rem .8rem;background:#1a1a1a;border:1px solid #333;border-radius:6px;color:#e0e0e0;font-size:.9rem}
select:focus,textarea:focus{border-color:#ff6b35;outline:none}
select{cursor:pointer;appearance:auto}
textarea{height:320px;font-family:monospace;font-size:.82rem;resize:vertical}
button,.btn{display:inline-block;margin-top:1rem;padding:.65rem 1.4rem;border:none;border-radius:6px;font-size:.95rem;font-weight:600;cursor:pointer;text-decoration:none;text-align:center}
.btn-primary{background:#ff6b35;color:#fff}.btn-primary:hover{background:#e55a28}
.btn-success{background:#4caf50;color:#fff}.btn-success:hover{background:#3d8b40}
.btn-outline{background:transparent;color:#aaa;border:1px solid #444}.btn-outline:hover{border-color:#ff6b35;color:#ff6b35}
.card{background:#161616;border:1px solid #2a2a2a;border-radius:10px;padding:1.5rem 2rem;max-width:860px;margin-bottom:1.5rem}
.badge{display:inline-block;border-radius:4px;padding:.2rem .6rem;font-size:.75rem;margin-left:.5rem}
.ok{background:#1a3a1a;color:#4caf50}.warn{background:#3a2a1a;color:#ff9800}.err-badge{background:#3a1a1a;color:#f44336}
.saved{color:#4caf50;font-weight:600;margin-top:1rem}
.error{color:#f44336;font-weight:600;margin-top:1rem}
.hint{color:#666;font-size:.8rem;margin-top:.3rem}
.env-list{list-style:none;padding:0;margin:.8rem 0}
.env-list li{padding:.5rem .8rem;margin:.3rem 0;border-radius:6px;font-size:.9rem;display:flex;align-items:center;gap:.6rem}
.env-ok{background:#1a2a1a;border:1px solid #2a4a2a}
.env-missing{background:#2a1a1a;border:1px solid #4a2a2a}
.env-var{font-family:monospace;font-weight:600;color:#e0e0e0}
.env-hint{color:#888;font-size:.8rem}
.models{display:none;margin-top:.5rem}
.models.active{display:block}
details{margin-top:1.5rem}
details summary{cursor:pointer;color:#aaa;font-size:.9rem;padding:.5rem 0}
details summary:hover{color:#ff6b35}
.actions{display:flex;gap:.8rem;margin-top:1.2rem;flex-wrap:wrap}
.domain{color:#4caf50;font-size:.85rem;margin-top:.5rem}
.status-row{display:flex;align-items:center;gap:1rem;flex-wrap:wrap;margin-bottom:.5rem}
.step-num{display:inline-flex;align-items:center;justify-content:center;width:1.6rem;height:1.6rem;border-radius:50%;background:#ff6b35;color:#fff;font-size:.8rem;font-weight:700;margin-right:.4rem}
.step-done{background:#4caf50}
code{background:#1a1a1a;padding:.15rem .4rem;border-radius:3px;font-size:.85rem;color:#ff6b35}
</style></head>
<body>
<div class="card">
  <h1>🦞 OpenClaw Setup</h1>
  <div class="subtitle">Secure self-hosted AI assistant — Railway deployment</div>

  ${saved ? '<p class="saved">✓ Configuration saved. The gateway will reload automatically.</p>' : ""}
  ${error ? `<p class="error">✗ ${error}</p>` : ""}

  <div class="status-row">
    <span>Gateway: <span class="badge ${gatewayReady ? "ok" : "warn"}">${gatewayReady ? "Running ✓" : "Starting..."}</span></span>
    ${activeProvider ? `<span>Provider: <span class="badge ok">${activeProvider.name}</span></span>` : '<span>Provider: <span class="badge err-badge">Not configured</span></span>'}
    ${currentModel ? `<span>Model: <span class="badge ok">${currentModel}</span></span>` : ""}
  </div>
  ${PUBLIC_URL ? `<div class="domain">🌐 ${PUBLIC_URL}</div>` : ""}
  ${gatewayReady ? `<div class="actions"><a href="/?token=${encodeURIComponent(GATEWAY_TOKEN)}" target="_blank" class="btn btn-success">Open Control UI ↗</a></div>` : ""}
</div>

<!-- Step 1: API Key -->
<div class="card">
  <h2><span class="step-num ${hasAnyKey ? "step-done" : ""}">1</span> API Provider Key</h2>
  <p style="color:#aaa;font-size:.9rem;margin-bottom:1rem">
    API keys are stored securely in Railway environment variables — never in the config file.
    ${!hasAnyKey ? "Add one of these in <strong>Railway → your service → Variables</strong>:" : ""}
  </p>
  <ul class="env-list">
    ${providers.map(p => `
    <li class="${p.hasKey ? "env-ok" : "env-missing"}">
      <span>${p.hasKey ? "✓" : "✗"}</span>
      <span class="env-var">${p.envVar}</span>
      <span class="env-hint">— ${p.name}</span>
    </li>`).join("")}
  </ul>
  ${!hasAnyKey ? `
  <div style="margin-top:1rem;padding:1rem;background:#1a1a1a;border-radius:6px;border:1px solid #333">
    <p style="color:#ff9800;margin:0 0 .5rem">How to add your API key:</p>
    <ol style="color:#aaa;font-size:.85rem;margin:0;padding-left:1.2rem;line-height:1.8">
      <li>Open Railway → your <strong>openclaw</strong> service → <strong>Variables</strong> tab</li>
      <li>Click <strong>New Variable</strong></li>
      <li>Set the name to <code>OPENROUTER_API_KEY</code> (or another provider above)</li>
      <li>Paste your API key as the value</li>
      <li>Railway will <strong>automatically redeploy</strong> — come back to this page after</li>
    </ol>
  </div>` : `
  <div class="hint">To change provider, update the environment variable in Railway → Variables.</div>`}
</div>

<!-- Step 2: Model Selection -->
<div class="card">
  <h2><span class="step-num ${currentModel && hasAnyKey ? "step-done" : ""}">2</span> Model Selection</h2>
  ${hasAnyKey ? `
  <form method="POST" action="/setup/model">
    <label for="model">Choose your model</label>
    ${ANTHROPIC_API_KEY ? `
    <select name="model" id="model">
      <option value="anthropic/claude-opus-4-6" ${currentModel === "anthropic/claude-opus-4-6" ? "selected" : ""}>Claude Opus 4.6 (most capable)</option>
      <option value="anthropic/claude-sonnet-4-5-20250929" ${currentModel.includes("sonnet") ? "selected" : ""}>Claude Sonnet 4.5</option>
      <option value="anthropic/claude-haiku-4-5-20251001" ${currentModel.includes("haiku") ? "selected" : ""}>Claude Haiku 4.5 (fast & cheap)</option>
    </select>` : ""}
    ${OPENROUTER_API_KEY ? `
    <select name="model" id="model">
      <option value="openrouter/anthropic/claude-sonnet-4-5-20250929" ${currentModel.includes("sonnet") ? "selected" : ""}>Claude Sonnet 4.5 via OpenRouter</option>
      <option value="openrouter/anthropic/claude-opus-4-6" ${currentModel.includes("opus") ? "selected" : ""}>Claude Opus 4.6 via OpenRouter</option>
      <option value="openrouter/openai/gpt-4o" ${currentModel.includes("gpt-4o") ? "selected" : ""}>GPT-4o via OpenRouter</option>
      <option value="openrouter/google/gemini-2.5-pro" ${currentModel.includes("gemini") ? "selected" : ""}>Gemini 2.5 Pro via OpenRouter</option>
      <option value="openrouter/auto" ${currentModel === "openrouter/auto" ? "selected" : ""}>Auto (OpenRouter picks best)</option>
    </select>` : ""}
    ${OPENAI_API_KEY ? `
    <select name="model" id="model">
      <option value="openai/gpt-4o" ${currentModel === "openai/gpt-4o" ? "selected" : ""}>GPT-4o</option>
      <option value="openai/gpt-4.1" ${currentModel === "openai/gpt-4.1" ? "selected" : ""}>GPT-4.1</option>
      <option value="openai/o3" ${currentModel === "openai/o3" ? "selected" : ""}>o3 (reasoning)</option>
    </select>` : ""}
    <button type="submit" class="btn btn-primary" style="margin-top:1rem">Save Model</button>
  </form>
  ` : `<p style="color:#666">Complete Step 1 first — add an API key in Railway Variables.</p>`}
</div>

<!-- Step 3: Channels (info) -->
<div class="card">
  <h2><span class="step-num">3</span> Messaging Channels (optional)</h2>
  <p style="color:#aaa;font-size:.9rem">Add these in Railway → Variables to enable chat channels:</p>
  <ul class="env-list">
    <li class="${TELEGRAM_BOT_TOKEN ? "env-ok" : "env-missing"}">
      <span>${TELEGRAM_BOT_TOKEN ? "✓" : "○"}</span>
      <span class="env-var">TELEGRAM_BOT_TOKEN</span>
      <span class="env-hint">— from <a href="https://t.me/BotFather" target="_blank" style="color:#ff6b35">@BotFather</a></span>
    </li>
    <li class="${DISCORD_BOT_TOKEN ? "env-ok" : "env-missing"}">
      <span>${DISCORD_BOT_TOKEN ? "✓" : "○"}</span>
      <span class="env-var">DISCORD_BOT_TOKEN</span>
      <span class="env-hint">— from <a href="https://discord.com/developers/applications" target="_blank" style="color:#ff6b35">Discord Dev Portal</a></span>
    </li>
  </ul>
</div>

<!-- Advanced -->
<div class="card">
  <details>
    <summary>▸ Advanced: Edit openclaw.json directly</summary>
    <form method="POST" action="/setup">
      <label for="config">openclaw.json — <a href="https://docs.openclaw.ai/gateway/configuration" target="_blank" style="color:#ff6b35">config reference ↗</a></label>
      <textarea name="config" id="config">${configStr}</textarea>
      <div class="hint">Saved to /data/.openclaw/openclaw.json — persists across restarts and redeploys.</div>
      <button type="submit" class="btn btn-outline" style="margin-top:1rem">Save Raw Config</button>
    </form>
  </details>
</div>

</body></html>`;
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

    // Model selection — saves only model to config (keys stay in Railway env vars)
    if (url === "/setup/model" && req.method === "POST") {
      let body = "";
      req.on("data", chunk => (body += chunk));
      req.on("end", () => {
        try {
          const params = new URLSearchParams(body);
          const model = params.get("model") || "";

          if (!model) {
            const config = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) : {};
            res.writeHead(400, { "Content-Type": "text/html" });
            res.end(setupPage(config, false, "Please select a model."));
            return;
          }

          const config = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) : {};
          config.agents = config.agents || {};
          config.agents.defaults = config.agents.defaults || {};
          config.agents.defaults.model = { primary: model };

          // Apply security invariants
          config.gateway = config.gateway || {};
          config.gateway.bind = "loopback";
          config.gateway.auth = config.gateway.auth || {};
          config.gateway.auth.token = GATEWAY_TOKEN;
          config.gateway.controlUi = config.gateway.controlUi || {};
          config.gateway.controlUi.dangerouslyDisableDeviceAuth = true;
          if (!config.gateway.controlUi.allowedOrigins) {
            config.gateway.controlUi.allowedOrigins = PUBLIC_URL ? [PUBLIC_URL] : ["*"];
          }

          fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
          console.log(`[setup] Model set to: ${model}`);

          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(setupPage(config, true));
        } catch (e) {
          const config = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) : {};
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(setupPage(config, false, "Error: " + e.message));
        }
      });
      return;
    }

    // Raw config save (advanced editor)
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
          parsed.gateway.controlUi = parsed.gateway.controlUi || {};
          parsed.gateway.controlUi.dangerouslyDisableDeviceAuth = true;
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

  // Proxy to gateway — FIX #2: strip proxy headers
  if (!gatewayReady) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Gateway starting, please wait..." }));
    return;
  }

  // FIX #10: The Control UI JS reads the gateway token from the browser URL
  // (?token=XXX) and uses it for WebSocket authentication. If the user
  // navigates to / or /openclaw without the token, they get "token_missing".
  // Redirect these page loads to include the token so the JS can find it.
  // Only redirect HTML page requests, not API/asset/WS requests.
  const parsedUrl = new URL(url, `http://${req.headers.host || "localhost"}`);
  const isPageLoad = !parsedUrl.searchParams.has("token") &&
    (req.headers.accept || "").includes("text/html");
  const isControlUiPath = url === "/" || url === "/openclaw" || url === "/openclaw/";

  if (isPageLoad && isControlUiPath && GATEWAY_TOKEN) {
    const sep = url.includes("?") ? "&" : "?";
    res.writeHead(302, { Location: `${url}${sep}token=${encodeURIComponent(GATEWAY_TOKEN)}` });
    res.end();
    return;
  }

  // Also inject token into proxied HTTP requests (for API calls, asset loads, etc.)
  const proxyPath = url.includes("token=") ? url : (() => {
    const s = url.includes("?") ? "&" : "?";
    return `${url}${s}token=${encodeURIComponent(GATEWAY_TOKEN)}`;
  })();

  const cleanHeaders = stripProxyHeaders(req.headers);
  cleanHeaders["host"] = `${GATEWAY_HOST}:${GATEWAY_PORT}`;
  cleanHeaders["x-openclaw-token"] = GATEWAY_TOKEN;

  const proxyReq = http.request(
    { hostname: GATEWAY_HOST, port: GATEWAY_PORT, path: proxyPath, method: req.method, headers: cleanHeaders },
    proxyRes => { res.writeHead(proxyRes.statusCode, proxyRes.headers); proxyRes.pipe(res); }
  );
  proxyReq.on("error", e => {
    if (!res.headersSent) { res.writeHead(502); res.end(JSON.stringify({ error: e.message })); }
  });
  req.pipe(proxyReq);
});

// WebSocket passthrough — FIX #2: strip proxy headers, FIX #9: preserve real Origin
server.on("upgrade", (req, socket, head) => {
  if (!gatewayReady) { socket.destroy(); return; }
  const proxy = net.createConnection(GATEWAY_PORT, GATEWAY_HOST, () => {
    const headers = stripProxyHeaders(req.headers);
    headers["host"] = `${GATEWAY_HOST}:${GATEWAY_PORT}`;

    // FIX #10: Inject gateway token for WebSocket auth.
    // The gateway checks WS auth via: query param ?token=, Authorization header,
    // or Sec-WebSocket-Protocol — NOT via x-openclaw-token custom header.
    // Append token as query parameter (most reliable for WS handshake).
    let wsUrl = req.url || "/";
    const separator = wsUrl.includes("?") ? "&" : "?";
    wsUrl += `${separator}token=${encodeURIComponent(GATEWAY_TOKEN)}`;

    proxy.write(
      `${req.method} ${wsUrl} HTTP/1.1\r\n` +
      Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n") +
      `\r\n\r\n`
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
  console.log(`[wrapper] State dir: ${STATE_DIR}`);
  console.log(`[wrapper] Config: ${CONFIG_PATH}`);
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
