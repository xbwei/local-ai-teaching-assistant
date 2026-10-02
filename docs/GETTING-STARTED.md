# Getting started — Local first

Use a reviewed revision or an approved release of this repository. Run the commands from its checkout root. No private development checkout or OpenAI credential is required. [Product homepage](../README.md).

## Prerequisites

The reference environment is a single operator on **Apple Silicon macOS** with Ollama supporting MLX, Node **24.16.0** and npm **11.13.0**. Runtime compatibility is also checked with Node 24.19.0/npm 11.17.0; declared engines are Node >=24.16 <25 and npm >=11 <12. Python is optional developer tooling, not a runtime backend.

Reserve enough memory for your model plus the operating system; 24 GB unified memory is a practical reference choice, not a guaranteed minimum. See the [official Ollama Gemma MLX notes](https://ollama.com/blog/mlx-performance) and [model tags](https://ollama.com/library/gemma4/tags). `gemma4:12b-mlx` requires supported Apple Silicon/MLX; do not silently substitute another tag on unsupported hardware.

You need Git, an operator-controlled HTTPS reverse proxy, and a modern browser. The Quick Start gives a **loopback-only Caddy reference configuration** for the existing HTTPS transport boundary. It is deployment infrastructure, not another application backend. Caddy 2.11.6 is the tested reference; it must be installed separately and its local CA trusted on your operator browser. Do not expose this configuration to a network.

## Quick Start — Local only

Install the prerequisites first. These commands use only this repository and your own local runtime. No OpenAI key is needed.

```bash
git clone https://github.com/xbwei/local-ai-teaching-assistant.git
cd local-ai-teaching-assistant
npm ci --ignore-scripts
npm run build
ollama pull gemma4:12b-mlx
ollama pull llama3.1:8b
```

Start Ollama using its macOS app or `ollama serve` if it is not already running. Install only models you intend to use; the alternate can be installed later. Do not run a second Ollama server on an occupied port.

Create an operator configuration **outside the checkout**. The accepted configuration requires an independent server-control verifier; this generates your own control token and stores only its hash in JSON. The protected token file is for existing server-control APIs, not OpenAI and not a dashboard login:

```bash
umask 077
mkdir -p "$HOME/.local/share/laita/config"
chmod 700 "$HOME/.local/share/laita/config"
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
const config = JSON.parse(readFileSync('ops/macos/application-config.json.template', 'utf8'));
config.runtimeRoot = `${homedir()}/.local/share/laita/runtime`;
// Existing server-control credential; never used as a browser/dashboard login.
const controlToken = randomBytes(32).toString('base64url');
config.access.enabled = true;
config.access.adminCredentials = [{ id: 'operator-control', tokenSha256: createHash('sha256').update(controlToken).digest('hex'), expiresAtEpochSeconds: Math.floor(Date.now()/1000) + 30*86400, revoked: false }];
writeFileSync(`${homedir()}/.local/share/laita/config/control-token`, controlToken, { mode: 0o600 });
writeFileSync(`${homedir()}/.local/share/laita/config/application.json`, JSON.stringify(config, null, 2), { mode: 0o600 });
JS
npm run course-sources:refresh -- "$HOME/.local/share/laita/runtime"
```

Public course refresh is optional for general chat. It needs read-only access to public GitHub APIs, uses no GitHub token, and can hit unauthenticated rate limits. Missing course evidence fails visibly; it does not trigger ungrounded answering.

In one terminal, start the API, which also serves the built UI:

```bash
APP_CONFIG_JSON="$(cat "$HOME/.local/share/laita/config/application.json")" npm start
```

In another terminal, from the same checkout, start the loopback HTTPS edge:

```bash
caddy run --config ops/reference/Caddyfile --adapter caddyfile
```

Open **https://localhost:3443**. Trust only the local CA you installed yourself; do not bypass unexpected certificate errors. The backend port 3100 is loopback-only and is not the browser entry. The HTTPS edge requires the exact Host and fixes security forwarding headers. It preserves each page’s random, non-secret transient client reference, so opening or resetting another browser/tab does not reset the first. All clients share the same single-operator History and global one-operation limit; overlapping generation returns BUSY without a queue. This reference is not a login or authority credential.

Try a general question, then a follow-up. Open `/history` from the UI. Stop foreground processes with Ctrl-C. Unset `APP_CONFIG_JSON` selects a fail-closed developer scaffold rather than this full operator profile; `.env` is not loaded automatically.

## Models and provider modes

Use the visible Local model selector to switch explicitly between Gemma 12B and Llama 8B. LAITA unloads the old primary model, checks the selected model and uses bounded idle residency. It does not install models or fall back automatically. `ollama list` shows installed models. Download errors, unavailable tags or resource pressure require operator action.

Local-only configuration sets `features.openai` and `features.compare` to `false` and `providers.openai.secretReference` to `null`. The UI shows configured modes and visible availability. An unavailable selected mode remains unavailable until you explicitly choose another mode.

## Deployment, troubleshooting and recovery

[Deployment guide](DEPLOYMENT.md) documents configuration, the loopback HTTPS boundary, LaunchAgent service lifecycle, explicit updates and rollback. It uses operator-owned paths and secrets only.

| Symptom | Check / recovery |
|---|---|
| UI unavailable / FORBIDDEN | Use the configured HTTPS origin; check proxy overwrites and exact origin. Do not expose or fake trusted headers from the browser. |
| Local unavailable | Start Ollama, run `ollama list`, install the exact selected tag and refresh choices. No silent model/provider substitution. |
| Grounding missing/stale | Refresh sources; check GitHub network/rate limit and snapshot status. Preserve failure rather than invent evidence. |
| OpenAI unavailable | Check flags, non-secret reference mapping and your Keychain item/account permissions. Never print the key for diagnosis. |
| BUSY | Wait for/cancel the admitted operation; no queue or background worker is created. |
| Invalid configuration | Check complete JSON and v4 provenance; empty/malformed `APP_CONFIG_JSON` does not fall back to defaults. |
| History recording incomplete | Stop admissions and preserve the local runtime; check storage permissions/capacity. Do not treat partial capture as success. |
| Speech unavailable / long answer silent | Check validated profile/voices, mute/autoplay status and documented speech bounds. Complete text remains available. |
| Restart budget exhausted | Fix the cause, then explicitly restart using `service.sh`; do not blindly loop retries. |
