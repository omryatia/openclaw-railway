# 🦞 OpenClaw — Secure Railway Template

> Self-hosted personal AI assistant with hardened defaults.
> Supports WhatsApp, Telegram, Slack, Discord, and more.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template/YOUR_TEMPLATE_ID)

---

## What makes this template different

Most Railway templates for OpenClaw treat the gateway token as optional and leave DM policy open or on "pairing". This template enforces security from boot:

| Setting | This template | Others |
|---|---|---|
| `GATEWAY_TOKEN` | **Required**, fails if missing | Optional |
| `SETUP_PASSWORD` | **Required**, min 12 chars | Optional or absent |
| Gateway bind | `loopback` only | `lan` or `0.0.0.0` |
| DM policy | `allowlist` (strangers blocked) | `pairing` or `open` |
| Non-main sessions | Sandboxed (Docker) | Unsandboxed |
| Container user | `node` (non-root) | Varies |
| Security invariants | Enforced at save | None |

---

## Prerequisites

- Railway account (Hobby plan, $5/month — free tier may not fit image size)
- At least one AI provider key: `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY`
- Optional: Telegram bot token, Discord bot token

---

## One-click deploy

Click the badge above. Railway will prompt you for variables, create a persistent volume at `/data`, and start the build (~3–5 min).

---

## Required variables

| Variable | Description |
|---|---|
| `GATEWAY_TOKEN` | Auth token, min 32 chars. Generate: `openssl rand -hex 32` |
| `SETUP_PASSWORD` | Password for the `/setup` wizard, min 12 chars |
| `ANTHROPIC_API_KEY` | Anthropic key (Claude models) |
| `OPENROUTER_API_KEY` | OpenRouter key (GPT-4o, Gemini, Claude via one key) |

### Optional

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | From @BotFather — enables Telegram channel |
| `DISCORD_BOT_TOKEN` | Discord bot token — enables Discord channel |

---

## After deploy

1. Visit `https://your-service.up.railway.app/setup`
2. Enter your `SETUP_PASSWORD` when prompted (Basic Auth dialog)
3. Edit the JSON config to add `allowFrom` entries for your Telegram/Discord user IDs
4. Save — changes persist to `/data/.openclaw/openclaw.json`
5. Restart the service in Railway to apply

### Add yourself to the DM allowlist

Find your Telegram user ID with `@userinfobot`, then in `/setup`:

```json
"channels": {
  "telegram": {
    "dmPolicy": "allowlist",
    "allowFrom": ["YOUR_TELEGRAM_USER_ID"]
  }
}
```

---

## Architecture

```
Railway (HTTPS)
      │
      ▼
Wrapper server :8080 (Express)
  ├─ /setup       → Password-gated config wizard
  ├─ /healthz     → Railway health check
  └─ /*           → Reverse proxy → OpenClaw gateway :18789 (loopback only)

/data (Railway Volume)
  ├─ .openclaw/openclaw.json   ← config + credentials
  └─ workspace/                ← agent workspace
```

The gateway never binds to a public interface. All external traffic enters through the wrapper, which injects the `x-openclaw-token` header.

---

## Security notes

- The setup wizard enforces these invariants regardless of what you edit:
  - `gateway.bind: "loopback"` — cannot be changed to public via the UI
  - `gateway.auth.token` — always set to `GATEWAY_TOKEN`
  - Non-main sessions always sandboxed
- The config file is written with mode `0600` (owner-only)
- Container runs as `node` user (uid 1000), not root
- No Tailscale automation — set this up manually if needed

---

## Updating OpenClaw

To pull the latest OpenClaw, trigger a redeploy in Railway. The Dockerfile builds from source on each deploy. Your config in `/data` is untouched.

---

## License

MIT — OpenClaw is [openclaw/openclaw](https://github.com/openclaw/openclaw). This template is a deployment wrapper.
