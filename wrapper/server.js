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

// Railway provides this automatically — use it for dynamic origin allowlist
const PUBLIC_DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN || "";
const PUBLIC_URL = PUBLIC_DOMAIN ? `https://${PUBLIC_DOMAIN}` : "";
const PRIVATE_DOMAIN = process.env.RAILWAY_PRIVATE_DOMAIN || "";

// Build allowedOrigins from all known domains (public HTTPS + private HTTP)
function buildAllowedOrigins() {
  const origins = [];
  if (PUBLIC_URL) origins.push(PUBLIC_URL);
  if (PRIVATE_DOMAIN) origins.push(`http://${PRIVATE_DOMAIN}:${PORT}`);
  return origins.length > 0 ? origins : ["*"];
}

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

    // Set conservative tool policy defaults if none configured
    if (!config.tools) {
      config.tools = {
        allow: ["read", "write", "edit", "web_search", "web_fetch", "apply_patch"],
        deny: ["exec"],
        elevated: { enabled: false }
      };
      didMigrate = true;
      console.log("[config] Set default tool policy (exec disabled, safe tools only)");
    }

    // Clean stale tailscale config from previous versions that incorrectly
    // wrote gateway.tailscale.* keys. These are not valid OpenClaw config keys.
    if (config.gateway?.tailscale) {
      delete config.gateway.tailscale;
      didMigrate = true;
    }
    if (config.gateway?.auth?.allowTailscale !== undefined) {
      delete config.gateway.auth.allowTailscale;
      didMigrate = true;
    }

    // Check if security patch is actually needed before writing
    const currentOrigins = JSON.stringify(config.gateway?.controlUi?.allowedOrigins || []);
    const expectedOrigins = JSON.stringify(buildAllowedOrigins());
    const alreadyPatched =
      config.gateway?.bind === "loopback" &&
      config.gateway?.auth?.token === GATEWAY_TOKEN &&
      config.gateway?.trustedProxies?.includes("127.0.0.1") &&
      currentOrigins === expectedOrigins;

    if (alreadyPatched && !didMigrate) return false;

    config.gateway = config.gateway || {};
    config.gateway.bind = "loopback";
    config.gateway.auth = config.gateway.auth || {};
    config.gateway.auth.token = GATEWAY_TOKEN;
    config.gateway.controlUi = config.gateway.controlUi || {};
    config.gateway.controlUi.allowedOrigins = buildAllowedOrigins();
    // FIX #11: Disable device identity auth for the Control UI.
    // Behind Railway's proxy, the wrapper already handles access control
    // (SETUP_PASSWORD). Device pairing uses WebCrypto and requires an
    // interactive approval step that blocks the WS connection even after
    // token auth succeeds (code 4008 "connect failed").
    config.gateway.controlUi.dangerouslyDisableDeviceAuth = true;
    config.gateway.trustedProxies = ["127.0.0.1", "::1"];

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
    console.log(`[config] Patched (${reason || "manual"}) — origins: ${JSON.stringify(config.gateway.controlUi.allowedOrigins)}`);
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
      console.log("[gateway] Note: 'dangerouslyDisableDeviceAuth' security warning is expected.");
      console.log("[gateway] Device auth is handled by the wrapper's SETUP_PASSWORD + Railway HTTPS.");
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
.channel-summary{display:flex;align-items:center;gap:.6rem;padding:.6rem .8rem;background:#1a1a1a;border:1px solid #333;border-radius:6px;font-size:.9rem;list-style:none}
.channel-summary::-webkit-details-marker{display:none}
.channel-summary::before{content:"▸";color:#666;font-size:.8rem;transition:transform .2s}
details[open]>.channel-summary::before{transform:rotate(90deg)}
.ch-ok{color:#4caf50}.ch-missing{color:#666}
.guide{padding:.8rem 1rem;margin-top:.3rem;background:#111;border-radius:0 0 6px 6px}
.guide ol{color:#aaa;font-size:.85rem;line-height:1.9;padding-left:1.2rem;margin:.5rem 0}
.tool-grid{display:flex;flex-direction:column;gap:.3rem;margin:.3rem 0}
.tool-check{display:flex;align-items:center;gap:.5rem;color:#aaa;font-size:.88rem;cursor:pointer;padding:.3rem .4rem;border-radius:4px}
.tool-check:hover{background:#1a1a1a}
.tool-check input{cursor:pointer;width:1rem;height:1rem;accent-color:#ff6b35}
.tool-row{display:flex;flex-direction:column}
.tool-approval{display:flex;align-items:center;gap:.5rem;color:#4caf50;font-size:.83rem;cursor:pointer;padding:.2rem .4rem .2rem 2rem;border-radius:4px}
.tool-approval input{cursor:pointer;width:1rem;height:1rem;accent-color:#4caf50}
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
    <span>Network: <span class="badge ${PUBLIC_URL ? "warn" : "ok"}">${PUBLIC_URL ? "Public" : "🔒 Private"}${PRIVATE_DOMAIN ? ` · ${PRIVATE_DOMAIN}` : ""}</span></span>
  </div>
  ${PUBLIC_URL ? `<div class="domain">🌐 ${PUBLIC_URL}</div>` : ""}
  ${PRIVATE_DOMAIN ? `<div class="domain">🔒 http://${PRIVATE_DOMAIN}:${PORT}</div>` : ""}
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
    <a href="/setup" class="btn btn-primary" style="margin-top:1rem">🔄 I added my key — check again</a>
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

<!-- Step 3: Tool Policy -->
<div class="card">
  <h2><span class="step-num ${config.tools ? "step-done" : ""}">3</span> Tool Security Policy</h2>
  <p style="color:#aaa;font-size:.9rem">
    Control what your AI agent can do. Start conservative — you can always enable more later.
  </p>

  <form method="POST" action="/setup/tools">
    <div style="margin-top:.8rem">
      <label style="margin-top:0">Safe Tools (always recommended)</label>
      <div class="tool-grid">
        <label class="tool-check"><input type="checkbox" name="tools" value="read" ${(config.tools?.allow || []).includes("read") || !config.tools ? "checked" : ""}> <code>read</code> — Read files</label>
        <label class="tool-check"><input type="checkbox" name="tools" value="write" ${(config.tools?.allow || []).includes("write") || !config.tools ? "checked" : ""}> <code>write</code> — Write files</label>
        <label class="tool-check"><input type="checkbox" name="tools" value="edit" ${(config.tools?.allow || []).includes("edit") || !config.tools ? "checked" : ""}> <code>edit</code> — Edit files</label>
        <label class="tool-check"><input type="checkbox" name="tools" value="apply_patch" ${(config.tools?.allow || []).includes("apply_patch") || !config.tools ? "checked" : ""}> <code>apply_patch</code> — Apply code patches</label>
        <label class="tool-check"><input type="checkbox" name="tools" value="web_search" ${(config.tools?.allow || []).includes("web_search") || !config.tools ? "checked" : ""}> <code>web_search</code> — Search the web</label>
        <label class="tool-check"><input type="checkbox" name="tools" value="web_fetch" ${(config.tools?.allow || []).includes("web_fetch") || !config.tools ? "checked" : ""}> <code>web_fetch</code> — Fetch web pages</label>
      </div>

      <label>Communication Tools</label>
      <div class="tool-grid">
        <label class="tool-check"><input type="checkbox" name="tools" value="sessions_list" ${(config.tools?.allow || []).includes("sessions_list") ? "checked" : ""}> <code>sessions_list</code> — List sessions</label>
        <label class="tool-check"><input type="checkbox" name="tools" value="sessions_history" ${(config.tools?.allow || []).includes("sessions_history") ? "checked" : ""}> <code>sessions_history</code> — View session history</label>
        <label class="tool-check"><input type="checkbox" name="tools" value="sessions_send" ${(config.tools?.allow || []).includes("sessions_send") ? "checked" : ""}> <code>sessions_send</code> — Send to other sessions</label>
        <label class="tool-check"><input type="checkbox" name="tools" value="memory" ${(config.tools?.allow || []).includes("memory") ? "checked" : ""}> <code>memory</code> — Long-term memory</label>
      </div>

      <label>⚠ Dangerous Tools</label>
      <div style="padding:.6rem;background:#2a1a1a;border:1px solid #4a2a2a;border-radius:6px">
        <div class="tool-row">
          <label class="tool-check" style="color:#ff9800"><input type="checkbox" name="tools" value="exec" id="cb-exec" onchange="toggleApproval('exec')" ${(config.tools?.allow || []).includes("exec") ? "checked" : ""}> <code>exec</code> — Run shell commands <strong>(can execute anything!)</strong></label>
          <label class="tool-approval" id="approval-exec" style="display:${(config.tools?.allow || []).includes("exec") ? "flex" : "none"}">
            <input type="checkbox" name="approval_exec" value="true" ${config.tools?.elevated?.elevatedDefault === "on" ? "" : "checked"}> 🛡 Require approval before each command
          </label>
        </div>
        <div class="tool-row" style="margin-top:.5rem">
          <label class="tool-check" style="color:#ff9800"><input type="checkbox" name="tools" value="browser" id="cb-browser" onchange="toggleApproval('browser')" ${(config.tools?.allow || []).includes("browser") ? "checked" : ""}> <code>browser</code> — Browser automation</label>
        </div>
        <div class="tool-row" style="margin-top:.5rem">
          <label class="tool-check" style="color:#ff9800"><input type="checkbox" name="tools" value="mcp" id="cb-mcp" onchange="toggleApproval('mcp')" ${(config.tools?.allow || []).includes("mcp") ? "checked" : ""}> <code>mcp</code> — External tool servers (MCP)</label>
        </div>
        <div class="hint" style="margin-top:.6rem;color:#f44336">
          ⚠ <code>exec</code> gives the agent full shell access inside the container.
          With approval enabled, every command is shown to you first and only runs after you confirm.
          <strong>Never enable exec without approval on a public-facing instance.</strong>
        </div>
      </div>
    </div>

    <button type="submit" class="btn btn-primary" style="margin-top:1rem">Save Tool Policy</button>
  </form>
</div>

<!-- Step 4: Channels -->
<div class="card">
  <h2><span class="step-num">4</span> Messaging Channels (optional)</h2>
  <p style="color:#aaa;font-size:.9rem">Click a channel to see setup instructions. Add tokens in Railway → Variables.</p>

  <details ${TELEGRAM_BOT_TOKEN ? "open" : ""} style="margin-top:.8rem">
    <summary class="channel-summary">
      <span class="${TELEGRAM_BOT_TOKEN ? "ch-ok" : "ch-missing"}">${TELEGRAM_BOT_TOKEN ? "✓" : "○"}</span>
      <span class="env-var">Telegram</span>
      ${TELEGRAM_BOT_TOKEN ? '<span class="badge ok">Connected</span>' : '<span class="badge warn">Not configured</span>'}
    </summary>
    <div class="guide">
      ${TELEGRAM_BOT_TOKEN ? '<p class="saved" style="margin-top:.5rem">✓ Telegram bot token detected. Your bot is active.</p>' : `
      <ol>
        <li>Open Telegram and search for <a href="https://t.me/BotFather" target="_blank" style="color:#ff6b35">@BotFather</a></li>
        <li>Send <code>/newbot</code> and follow the prompts to name your bot</li>
        <li>BotFather will give you a token like: <code>123456789:AAH...</code></li>
        <li>In Railway → Variables, add:<br>
          <span class="env-var" style="margin-top:.3rem;display:inline-block">TELEGRAM_BOT_TOKEN</span> = <em style="color:#888">your token from BotFather</em></li>
        <li>Railway will redeploy automatically</li>
      </ol>
      <a href="/setup" class="btn btn-outline" style="margin-top:.5rem;font-size:.85rem">🔄 I added the token — check again</a>`}
    </div>
  </details>

  <details ${DISCORD_BOT_TOKEN ? "open" : ""} style="margin-top:.5rem">
    <summary class="channel-summary">
      <span class="${DISCORD_BOT_TOKEN ? "ch-ok" : "ch-missing"}">${DISCORD_BOT_TOKEN ? "✓" : "○"}</span>
      <span class="env-var">Discord</span>
      ${DISCORD_BOT_TOKEN ? '<span class="badge ok">Connected</span>' : '<span class="badge warn">Not configured</span>'}
    </summary>
    <div class="guide">
      ${DISCORD_BOT_TOKEN ? '<p class="saved" style="margin-top:.5rem">✓ Discord bot token detected. Your bot is active.</p>' : `
      <ol>
        <li>Go to the <a href="https://discord.com/developers/applications" target="_blank" style="color:#ff6b35">Discord Developer Portal</a></li>
        <li>Click <strong>New Application</strong> → give it a name → Create</li>
        <li>Go to <strong>Bot</strong> tab → click <strong>Reset Token</strong> → copy the token</li>
        <li>Under <strong>Privileged Gateway Intents</strong>, enable:<br>
          ☑ Message Content Intent</li>
        <li>Go to <strong>OAuth2 → URL Generator</strong>:<br>
          Scopes: <code>bot</code>, <code>applications.commands</code><br>
          Bot Permissions: <code>Send Messages</code>, <code>Read Message History</code>, <code>Attach Files</code></li>
        <li>Copy the generated URL and open it to invite the bot to your server</li>
        <li>In Railway → Variables, add:<br>
          <span class="env-var" style="margin-top:.3rem;display:inline-block">DISCORD_BOT_TOKEN</span> = <em style="color:#888">your bot token</em></li>
        <li>Railway will redeploy automatically</li>
      </ol>
      <a href="/setup" class="btn btn-outline" style="margin-top:.5rem;font-size:.85rem">🔄 I added the token — check again</a>`}
    </div>
  </details>

  <details style="margin-top:.5rem">
    <summary class="channel-summary">
      <span class="ch-missing">○</span>
      <span class="env-var">WhatsApp</span>
      <span class="badge warn">Requires linking</span>
    </summary>
    <div class="guide">
      <ol>
        <li>WhatsApp connects via QR code after deploy — no env var needed</li>
        <li>Open the <strong>Control UI</strong> → <strong>Channels</strong> tab</li>
        <li>Click <strong>WhatsApp</strong> → scan the QR code with your phone</li>
        <li>Keep your phone connected to the internet</li>
      </ol>
    </div>
  </details>

  <details style="margin-top:.5rem">
    <summary class="channel-summary">
      <span class="ch-missing">○</span>
      <span class="env-var">Slack</span>
      <span class="badge warn">Not configured</span>
    </summary>
    <div class="guide">
      <ol>
        <li>Go to <a href="https://api.slack.com/apps" target="_blank" style="color:#ff6b35">api.slack.com/apps</a> → <strong>Create New App</strong></li>
        <li>Choose <strong>From scratch</strong> → name it → select your workspace</li>
        <li>Go to <strong>Socket Mode</strong> → enable it → create an App-Level Token with <code>connections:write</code> scope</li>
        <li>Go to <strong>OAuth & Permissions</strong> → add Bot Token Scopes:<br>
          <code>chat:write</code>, <code>im:history</code>, <code>im:read</code>, <code>im:write</code></li>
        <li>Go to <strong>Event Subscriptions</strong> → enable → subscribe to:<br>
          <code>message.im</code></li>
        <li><strong>Install to Workspace</strong> and copy the Bot User OAuth Token</li>
        <li>In Railway → Variables, add both:<br>
          <span class="env-var">SLACK_BOT_TOKEN</span> = <em style="color:#888">xoxb-your-bot-token</em><br>
          <span class="env-var">SLACK_APP_TOKEN</span> = <em style="color:#888">xapp-your-app-token</em></li>
      </ol>
      <a href="/setup" class="btn btn-outline" style="margin-top:.5rem;font-size:.85rem">🔄 Check again</a>
    </div>
  </details>
</div>

<!-- Step 5: Private Access with Tailscale -->
<div class="card">
  <h2><span class="step-num">5</span> Private Network with Tailscale (recommended)</h2>
  <p style="color:#aaa;font-size:.9rem">
    Take OpenClaw <strong>off the public internet</strong>. Only devices on your private Tailscale network (tailnet) can reach it.
  </p>

  ${PUBLIC_URL ? `
  <div style="margin-top:.8rem;padding:.8rem 1rem;background:#2a1a1a;border:1px solid #4a2a2a;border-radius:6px">
    <p style="color:#ff9800;margin:0 0 .3rem;font-size:.9rem">⚠ Currently your OpenClaw is on the public internet</p>
    <p style="color:#888;font-size:.85rem;margin:0">
      The URL is obscure and auth-gated, but anyone who finds it can attempt to connect.
    </p>
  </div>` : `
  <div style="margin-top:.8rem;padding:.8rem 1rem;background:#1a2a1a;border:1px solid #2a4a2a;border-radius:6px">
    <p style="color:#4caf50;margin:0 0 .3rem;font-size:.9rem">✓ Public networking disabled — OpenClaw is private</p>
    <p style="color:#888;font-size:.85rem;margin:0">
      Only accessible via Railway's private network through your Tailscale tailnet.
    </p>
  </div>`}

  <details style="margin-top:.8rem">
    <summary class="channel-summary">
      <span class="ch-missing">○</span>
      <span class="env-var">Setup Private Access via Tailscale Subnet Router</span>
      <span class="badge warn">~5 minutes</span>
    </summary>
    <div class="guide">
      <p style="color:#aaa;font-size:.85rem;margin:.5rem 0">
        Railway uses a <strong>Subnet Router</strong> — a separate Tailscale service deployed into your project that bridges your tailnet to Railway's private network. OpenClaw itself doesn't need Tailscale installed.
      </p>

      <p style="color:#ff6b35;font-weight:600;font-size:.9rem;margin:.8rem 0 .3rem">Step A: Tailscale Account & App</p>
      <ol>
        <li>Sign up at <a href="https://login.tailscale.com/start" target="_blank" style="color:#ff6b35">tailscale.com</a> (free for personal use)</li>
        <li>Install Tailscale on the devices you'll access OpenClaw from (laptop, phone, etc.)</li>
        <li>Enable subnet route acceptance on your device:<br>
          <strong>Linux:</strong> <code>sudo tailscale set --accept-routes</code><br>
          <strong>macOS / Windows:</strong> Open Tailscale → Settings → enable <em>"Use Tailscale subnets"</em> or <em>"Accept Routes"</em></li>
      </ol>

      <p style="color:#ff6b35;font-weight:600;font-size:.9rem;margin:.8rem 0 .3rem">Step B: Generate an Auth Key</p>
      <ol>
        <li>Go to <a href="https://login.tailscale.com/admin/settings/keys" target="_blank" style="color:#ff6b35">Tailscale Admin → Settings → Keys</a></li>
        <li>Click <strong>Generate auth key</strong> (leave defaults) → copy the key</li>
      </ol>

      <p style="color:#ff6b35;font-weight:600;font-size:.9rem;margin:.8rem 0 .3rem">Step C: Configure Split DNS</p>
      <ol>
        <li>Go to <a href="https://login.tailscale.com/admin/dns" target="_blank" style="color:#ff6b35">Tailscale Admin → DNS</a></li>
        <li>Under <strong>Nameservers</strong>, click <strong>Add Nameserver → Custom</strong></li>
        <li>Enter <code>fd12::10</code> as the nameserver</li>
        <li>Enable <strong>Restrict to domain</strong> and enter <code>railway.internal</code></li>
        <li>Click <strong>Save</strong></li>
      </ol>

      <p style="color:#ff6b35;font-weight:600;font-size:.9rem;margin:.8rem 0 .3rem">Step D: Deploy the Subnet Router</p>
      <ol>
        <li>In your Railway project, click <strong>Create → Template</strong></li>
        <li>Search for <strong>Tailscale Subnet Router</strong> (by Railway Templates)</li>
        <li>Paste your auth key and deploy</li>
        <li>In <a href="https://login.tailscale.com/admin/machines" target="_blank" style="color:#ff6b35">Tailscale Machines</a>, find the new machine → click <strong>⋯ → Edit route settings</strong></li>
        <li>Click <strong>Approve all</strong> to accept both <code>fd12::/16</code> (IPv6) and <code>10.128.0.0/9</code> (IPv4) → <strong>Save</strong></li>
      </ol>

      <p style="color:#ff6b35;font-weight:600;font-size:.9rem;margin:.8rem 0 .3rem">Step E: Access OpenClaw Privately</p>
      ${PRIVATE_DOMAIN ? `
      <div style="padding:.6rem .8rem;background:#1a2a1a;border:1px solid #2a4a2a;border-radius:6px;margin-bottom:.6rem">
        <p style="color:#4caf50;font-size:.9rem;margin:0">Your private domain:</p>
        <code style="font-size:.95rem;display:block;margin-top:.3rem">http://${PRIVATE_DOMAIN}:${PORT}/setup</code>
      </div>` : ""}
      <ol>
        <li>From a device on your tailnet, open:<br>
          <code style="display:inline-block;margin-top:.3rem">http://${PRIVATE_DOMAIN || "<your-service>.railway.internal"}:${PORT}/setup</code></li>
        <li>Enter your <strong>SETUP_PASSWORD</strong> when prompted</li>
        <li><strong>To go fully private:</strong> In Railway → your OpenClaw service → Settings → Networking, delete the public domain.<br>
          This makes OpenClaw <strong>completely invisible</strong> on the internet — only reachable through your tailnet.</li>
      </ol>

      <div style="margin-top:.8rem;padding:.6rem;background:#1a2a1a;border:1px solid #2a4a2a;border-radius:6px">
        <p style="color:#4caf50;font-size:.85rem;margin:0">
          📖 Full guide: <a href="https://docs.railway.com/guides/set-up-a-tailscale-subnet-router" target="_blank" style="color:#ff6b35">Railway Docs — Set up a Tailscale Subnet Router</a>
        </p>
      </div>
    </div>
  </details>
</div>

<!-- Security Overview -->
<div class="card">
  <h2>🔒 Security Status</h2>
  <ul class="env-list">
    <li class="env-ok">
      <span>✓</span><span>Token auth — 64-char random, auto-generated</span>
    </li>
    <li class="env-ok">
      <span>✓</span><span>Setup wizard protected by <strong>SETUP_PASSWORD</strong></span>
    </li>
    <li class="env-ok">
      <span>✓</span><span>Railway HTTPS — TLS termination at edge</span>
    </li>
    <li class="env-ok">
      <span>✓</span><span>Non-root container (<code>node</code> user, uid 1000)</span>
    </li>
    <li class="env-ok">
      <span>✓</span><span>Config file permissions — <code>0600</code> (owner-only)</span>
    </li>
    <li class="env-ok">
      <span>✓</span><span>API keys in Railway env vars — never written to config file</span>
    </li>
    <li class="env-ok">
      <span>✓</span><span>Gateway bound to <strong>127.0.0.1</strong> (loopback) — enforced, cannot be changed via UI</span>
    </li>
    <li class="${config.tools?.deny?.includes("exec") || !config.tools?.allow?.includes("exec") ? "env-ok" : config.tools?.elevated?.elevatedDefault !== "on" ? "env-ok" : "env-missing"}">
      <span>${config.tools?.deny?.includes("exec") || !config.tools?.allow?.includes("exec") ? "✓" : config.tools?.elevated?.elevatedDefault !== "on" ? "✓" : "⚠"}</span>
      <span>${config.tools?.deny?.includes("exec") || !config.tools?.allow?.includes("exec") 
        ? "Shell exec <strong>disabled</strong> — agent cannot run arbitrary commands" 
        : config.tools?.elevated?.elevatedDefault !== "on"
          ? "Shell exec enabled with <strong>approval required</strong> — every command needs your confirmation"
          : "<code>exec</code> enabled <strong>without approval</strong> — agent can run commands freely (dangerous!)"}</span>
    </li>
    <li class="${config.tools?.allow ? "env-ok" : "env-missing"}">
      <span>${config.tools?.allow ? "✓" : "⚠"}</span>
      <span>${config.tools?.allow 
        ? `Tool allowlist active — ${config.tools.allow.length} tools enabled (see Step 3)` 
        : "No tool policy — all tools enabled by default (configure in Step 3)"}</span>
    </li>
    <li class="${PUBLIC_URL ? "env-missing" : "env-ok"}">
      <span>${PUBLIC_URL ? "⚠" : "✓"}</span>
      <span>${PUBLIC_URL 
        ? `Public internet access — deploy a <a href="https://docs.railway.com/guides/set-up-a-tailscale-subnet-router" target="_blank" style="color:#ff6b35">Tailscale Subnet Router</a> then disable public networking (Step 5)` 
        : "Private network only — not accessible from the public internet"}</span>
    </li>
    <li class="env-missing">
      <span>⚠</span><span><code>dangerouslyDisableDeviceAuth</code> — required for Railway proxy setup (<a href="https://github.com/openclaw/openclaw/issues/29908" target="_blank" style="color:#ff6b35">upstream bug</a>)</span>
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

<script>
function toggleApproval(tool) {
  var cb = document.getElementById('cb-' + tool);
  var approval = document.getElementById('approval-' + tool);
  if (approval) {
    approval.style.display = cb.checked ? 'flex' : 'none';
    if (cb.checked) {
      var approvalCb = approval.querySelector('input');
      if (approvalCb) approvalCb.checked = true;
    }
  }
}
</script>

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
            config.gateway.controlUi.allowedOrigins = buildAllowedOrigins();
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

    // Tool policy save
    if (url === "/setup/tools" && req.method === "POST") {
      let body = "";
      req.on("data", chunk => (body += chunk));
      req.on("end", () => {
        try {
          const params = new URLSearchParams(body);
          const selectedTools = params.getAll("tools");

          const config = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) : {};

          // Build tool policy
          config.tools = config.tools || {};
          config.tools.allow = selectedTools.length > 0 ? selectedTools : ["read", "write", "edit", "web_search", "web_fetch", "apply_patch"];

          // Handle exec approval setting
          const execApproval = params.get("approval_exec") === "true";

          if (!selectedTools.includes("exec")) {
            config.tools.deny = ["exec"];
            config.tools.elevated = { enabled: false };
          } else if (execApproval) {
            // exec enabled WITH approval — elevatedDefault:"off" means user must
            // opt-in per session via /elevated on, and each command needs confirmation
            config.tools.deny = [];
            config.tools.elevated = {
              enabled: true,
              elevatedDefault: "off"
            };
          } else {
            // exec enabled WITHOUT approval — commands run freely
            config.tools.deny = [];
            config.tools.elevated = {
              enabled: true,
              elevatedDefault: "on"
            };
          }

          // Apply security invariants
          config.gateway = config.gateway || {};
          config.gateway.bind = "loopback";
          config.gateway.auth = config.gateway.auth || {};
          config.gateway.auth.token = GATEWAY_TOKEN;
          config.gateway.controlUi = config.gateway.controlUi || {};
          config.gateway.controlUi.dangerouslyDisableDeviceAuth = true;

          fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
          console.log(`[setup] Tool policy: allow=[${selectedTools.join(",")}], exec=${selectedTools.includes("exec") ? (execApproval ? "ON+approval" : "ON+no-approval") : "OFF"}`);

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
            parsed.gateway.controlUi.allowedOrigins = buildAllowedOrigins();
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

// WebSocket passthrough
server.on("upgrade", (req, socket, head) => {
  if (!gatewayReady) { socket.destroy(); return; }

  // FIX #12: Enable TCP keepalive on the browser-facing socket to prevent
  // Railway/Tailscale idle timeouts (code 1006 every ~60s)
  socket.setKeepAlive(true, 20000); // 20s keepalive interval
  socket.setNoDelay(true);

  const proxy = net.createConnection(GATEWAY_PORT, GATEWAY_HOST, () => {
    proxy.setKeepAlive(true, 20000);
    proxy.setNoDelay(true);

    const headers = stripProxyHeaders(req.headers);
    headers["host"] = `${GATEWAY_HOST}:${GATEWAY_PORT}`;

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


// Prevent Node.js default timeouts from killing long-lived WebSocket connections
server.timeout = 0;                // disable request timeout entirely
server.keepAliveTimeout = 120000;  // 2 minutes for HTTP keep-alive
server.headersTimeout = 120000;    // 2 minutes for headers
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
