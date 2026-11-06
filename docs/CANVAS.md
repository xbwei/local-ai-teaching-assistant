# Optional Canvas course App — v0.2.0 candidate

This early-adopter reference connects **one Owner, one Canvas course and one Instructor identity** to the existing local Teacher role. Admin, Teacher and Student are three views operated by that same Owner, not three real people. Canvas is an authentication/context entry point into the same API, chat, grounding, SQLite and History. It does not fetch Canvas content or provision accounts or memberships.

## 1. Install and initialize standalone access

Complete [Getting started](GETTING-STARTED.md), including the pinned Node/npm installation, build, operator configuration, models and loopback HTTPS edge. No Canvas configuration, API token, OpenAI key or cloud speech service is needed for standalone use. Credential/configuration checks require macOS/Linux POSIX ownership; Windows is unsupported and fails closed.

Stop LAITA before credential maintenance. In its checkout, load the same operator configuration/runtime that you will use to start the API:

```bash
export APP_CONFIG_JSON="$(cat "$HOME/.local/share/laita/config/application.json")"
npm run owner:setup
```

Type and repeat one Owner passphrase in the Terminal's hidden prompts. Use at least 15 characters (maximum 1024 UTF-8 bytes), preferably a unique password-manager-generated passphrase. Input is not echoed, accepted from redirected stdin, passed as a command argument or read from a password environment variable. There is no built-in usable password. SQLite stores only a random 128-bit salt, a 256-bit scrypt verifier and a random credential revision. The fixed scrypt parameters are N=131072, r=8, p=1; the application permits one derivation at a time and 20 login attempts per minute. A pinned Express rate-limit middleware additionally bounds the authentication entry and control routes to a shared 600 requests/minute using one constant Owner key, without collecting IP/person identities.

Start LAITA and its HTTPS edge as documented. Open `https://localhost:3443`, choose Admin, Teacher or Student and enter the same Owner passphrase. Sign out to change role. Simultaneous roles require separate browser profiles: a cookie is shared by tabs in one profile. Never give this passphrase to students or other instructors. Re-running `owner:setup` replaces the credential and invalidates existing role sessions without deleting History.

| Entry | Authority and History |
|---|---|
| Standalone Admin | Local administrative control APIs and all Owner History, including pre-v0.2 records |
| Standalone Teacher | Chat and Teacher History, including this Owner's Canvas contexts; cannot use Admin control APIs |
| Standalone Student | Chat and Student History/feedback; cannot review records as Owner or use Admin control APIs |
| Canvas Teacher | Same Teacher identity, with History restricted to the configured Canvas origin/course/identity context; cannot use Admin control APIs |

Sessions use an opaque, random, Secure/HttpOnly/SameSite=Lax cookie with an eight-hour maximum lifetime. No passphrase or bearer is saved in browser storage. Server-side browser sessions are transient; API restart signs them out. Conversation references are bound to both the authenticated session and each page's random client reference. Copying a conversation reference into a different role/session does not transfer access. The existing one-operation BUSY/no-queue limit remains global.

## 2. Prepare the optional Canvas connection

Your Canvas permissions must allow **course-level external Apps installed with Paste XML and a consumer key/shared secret**. Ask your Canvas administrator about availability if this UI is disabled. This implementation does not support institution-wide registration or LTI 1.3.

The Owner's browser must reach both Canvas and the configured LAITA HTTPS origin. For an instructor working on the same Mac, the existing trusted `https://localhost:3443` entry can be used; the browser posts the launch form to localhost. Canvas servers do not need to call the LAITA API. Browser private-network/loopback policies or institution policy may block this. Confirm on your own authorized setup. The supplied Caddyfile stays loopback-only. A remote browser requires a separately configured, independently protected Owner entry with the exact public origin and fixed forwarding headers; it is outside this reference setup. Do not open the loopback API or expose this candidate as a hosted service.

Identify your own numeric Canvas **course ID** and **user ID** using your authorized Canvas UI/course profile or your Canvas administrator. The LTI `context_id` and opaque `user_id` are not substitutes for these numeric Canvas values. No Canvas REST API or API token is used. Generic examples are `https://canvas.example.test`, course `42001`, user `73001`; these are synthetic and will not connect to a service.

Generate a new random consumer key (at least 16 characters) and shared secret (at least 32 random characters, ideally 256 bits) in your password manager. Store them privately there for transfer into the Canvas App settings and the next hidden Terminal prompts. Neither is a Canvas API token. Do not use institutional login credentials. Do not put secrets into shell commands/history, Git, issue reports, screenshots, application JSON or browser local/session storage.

## 3. Save one private local configuration

Use the same Terminal/operator configuration as above:

```bash
umask 077
mkdir -p "$HOME/.local/share/laita/config"
chmod 700 "$HOME/.local/share/laita/config"
export LAITA_CANVAS_CONFIG_FILE="$HOME/.local/share/laita/config/canvas.json"
npm run canvas:setup
```

The hidden prompts request Canvas HTTPS origin (origin only, no trailing slash/path), numeric course ID, numeric Owner user ID, consumer key and shared secret. The command creates a new 0600 file outside Git in a canonical owner-only directory; it refuses to overwrite an existing file. All ancestors must be trusted. No credential values are printed. The shared secret must be available for HMAC verification, so it resides in this protected local file, separate from SQLite, rather than as a password hash. Keep your account/disk protected; no new encrypted vault is claimed.

Start the existing API with **both** `APP_CONFIG_JSON` and `LAITA_CANVAS_CONFIG_FILE` exported in its process environment. The optional file is revalidated on launch and Canvas-session access. Absent, unreadable, non-private, malformed or disabled configuration closes Canvas access while standalone remains usable. Do not place Canvas secrets in `APP_CONFIG_JSON`.

The existing macOS LaunchAgent does not automatically inherit shell exports or configure Canvas. This candidate's Canvas instructions use the foreground API. Automated Canvas environment injection into that lifecycle is not included; do not assume shell exports configure a running service. Standalone credential access works with the existing lifecycle and its configured runtime.

## 4. Install the course App with Paste XML

Generate the configuration XML from the exact `access.publicOrigin` in your loaded application configuration:

```bash
# --silent keeps npm's banner out of the XML. This output contains no credentials.
npm run --silent canvas:xml > /tmp/laita-course-app.xml
```

Read the file locally and copy its XML. It includes the fixed `/api/v1/canvas/launch` URL, Canvas substitutions for API domain/course/user IDs, anonymous privacy, instructor/admin navigation visibility and a new-window target. Do not add names, email, roster or grade-service permissions.

In **the one intended Canvas course**, open **Settings → Apps → View App Configurations → + App** (wording varies). Select **Paste XML**, enter a local display name such as LAITA, enter your consumer key and shared secret from the password manager, paste the generated XML and add the App. If installation is denied, stop and use standalone LAITA; there is no registration or security-policy bypass in this project.

Reload the course navigation and launch LAITA as the configured Instructor in a **new top-level tab/window**. It should enter Teacher without another LAITA passphrase prompt. Verify the `Owner · Teacher · Canvas` label and try a non-sensitive synthetic question, then History. The application disallows framing; if Canvas tries an iframe, verify the App's new-window configuration. Do not weaken CSP or cookie protections to make embedding work.

The verifier requires the exact HTTP Canvas Origin, signed `$Canvas.api.domain` host (including any configured port), signed numeric course/user substitutions, an Instructor role, OAuth consumer key/version/HMAC-SHA1 signature, timestamp within ±300 seconds, and a previously unused nonce. The signature URL is the configured canonical HTTPS launch URL, never an untrusted Host or forwarded URL. Query strings, duplicate form parameters, OAuth tokens and alternate signature methods are rejected. Only after these checks and atomic persistent nonce consumption does the API issue a Teacher cookie. Extra signed values cannot grant Admin or create users/memberships. Other public grounding sources remain the existing fixed public-source demonstrations, not Canvas course content or enrollments.

## 5. Disable, remove, rotate or recover

```bash
# Removes only the configured private Canvas file, not credentials or History.
npm run canvas:disable
```

Removal makes the next Canvas launch and next request using a Canvas session fail closed. A server restart also drops browser sessions. In Canvas course Settings, remove the LAITA external App and its navigation entry. Unset `LAITA_CANVAS_CONFIG_FILE` in future API processes. Standalone role credentials and retained History are unchanged. Alternatively, setting the private file's `enabled` field to `false` disables it; do not print its contents for diagnosis.

To rotate consumer key/shared secret, disable the local connection, generate replacements in your password manager, run `canvas:setup` again and update the course App to match. Existing Canvas sessions are invalidated. The stable course/identity History context is retained; standalone Teacher/Admin can still review it. Changing origin/course/identity selects a different context; no prior records are reassigned automatically. To recover a forgotten local passphrase, stop LAITA and repeat `owner:setup` with the same runtime, then restart.

Schema v5 adds the singleton verifier, bounded nonce table and role/context columns to the existing database. v1–v4 migration SQL/checksums are unchanged. Pre-v0.2 History is retained and visible only to local Admin. Older binaries refuse this newer schema: reverting application code alone is insufficient. For rollback, stop LAITA and use the existing [database backup/rollback procedure](DEPLOYMENT.md#explicit-update-and-recovery) with a **pre-v5** backup. Post-backup records and new credential state will not exist in that restored copy; preserve the newer database separately. Do not delete migration rows or downgrade the schema by hand. Disabling Canvas is the least disruptive rollback of the integration itself.

## Troubleshooting

Public failure responses deliberately omit submitted identifiers and signatures. Diagnose locally; share only synthetic reproductions, error codes and the reviewed revision.

| Symptom | Local checks |
|---|---|
| `403 FORBIDDEN`, suspected invalid signature | Consumer key/shared secret must match the App exactly; compare privately in the password manager. Check canonical HTTPS public origin, port and launch path, no redirect/rewrite/query string, and the signed Canvas substitutions in the generated XML. Do not log form bodies or signatures. |
| Wrong Canvas user | Launch from the configured Owner's Canvas login, with the exact numeric user ID in local setup; masquerading/testing as another participant is not supported. No automatic admission occurs. |
| Wrong course | Install/launch the App from the one configured numeric course, not a copied App in another course. |
| Wrong role | Course launch must carry `Instructor` or `urn:lti:role:ims/lis/Instructor`. Student, TA, Designer or platform Administrator alone is insufficient. |
| Stale/future timestamp | Synchronize the LAITA host and Canvas clocks. The window is ±300 seconds; do not enlarge it to mask clock errors. |
| Replayed launch / reloading POST | Launch afresh from Canvas for a new nonce. Do not resubmit a captured form or clear the nonce table. Nonces survive API restarts until the freshness window ends. |
| `503 SERVICE_UNAVAILABLE` | Initialize the local Owner credential. Check the API process's optional config path, private parent/file permissions (0700/0600), ownership, JSON schema, enabled state and secret lengths. Missing/disabled config does not fall back to unsigned access. |
| `401 UNAUTHENTICATED` after prior success | Session expired, API restarted, credential/config rotated/disabled, or another tab changed role. Re-launch from Canvas or sign in standalone. |
| `429 RATE_LIMITED` | Wait a minute. Login has 20 attempts/minute and one outstanding password derivation; Canvas has 120 launch attempts/minute. Use an independently protected Owner entry. |
| Empty/denied History | Check current role and Canvas context. Student/Teacher cannot read another role's records; Canvas sees only its configured context. Admin can inspect older retained records. |
| No new tab / certificate / browser private-network block | Trust only your own local HTTPS CA, confirm new-window App configuration and browser/institution policy. Use standalone while resolving the environment; never disable TLS, Origin checks or framing/cookie protections. |

Deterministic tests use generic/synthetic state. Real Canvas installation/substitution/origin/new-window behavior and real browser-to-loopback/private-network behavior require Owner checks and are **NOT_RUN** unless explicitly recorded for this Public revision. No new screenshots/GIFs are needed for this change; do not publish captures from a private deployment.
