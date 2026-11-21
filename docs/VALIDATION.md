# Validation and limitations

LAITA Public V1 is covered by deterministic engineering validation using synthetic fixtures. Use Node 24.16.0/npm 11.13.0, Caddy 2.11.6 and Python 3.12.14/uv 0.12.23 for these maintainer/CI gates. The source build (`npm ci --ignore-scripts && npm run build`) needs no Python, uv, Ruff or Codex. `.uv-version` pins the uv CLI independently of Python packaging; `python/pyproject.toml` retains `package = false` and the Ruff development group without an unused build backend. `npm run validate` installs locked dependencies and runs build, typecheck, import boundaries, formatting, Node/API/provider/history/speech/grounding/ops tests, process/workspace smoke, Python architecture fixtures, npm/uv audits, lockfile/runtime-cleanliness negatives and policy-contract/schema checks.

The compatibility gate uses Node 24.19.0/npm 11.17.0 and runs runtime/persistence/API/smoke validation. CI also checks actionlint, Git-history secrets using offline TruffleHog and Semgrep CE JavaScript/Python rules. These scans do not use paid AI/security services. The public repository has CodeQL default setup, hosted secret scanning and push protection enabled. Automated checks do not establish real model quality, speech/hardware acceptance or operator deployment readiness.

Opt-in browser validation: set `PLAYWRIGHT_MODULE` to your installed Playwright module and run `node scripts/test-browser-client.mjs` after build. It uses synthetic HTTPS/providers/audio/storage, not real model requests or physical microphones. The reference HTTPS configuration must be validated too. Fresh-clone setup smoke must use only LAITA files and isolated operator-owned runtime.

The browser fixture checks the phone's install guide, HTTPS manifest and icons and opens a chat with synthetic course provenance. Desktop and phone scenarios also exercise the signed Teacher Page preview, invalidation on edit, explicit creation and readback using a fake Canvas REST adapter. Set `CLIENT_CHROMIUM_BINARY` to use an installed Chromium executable outside the default Chrome location. Chromium viewport testing does not establish native Safari installation or real-device behavior.

Synthetic golden retrieval tests cover bilingual overview, Lab/Week locators, exact displayed evidence, active-context preservation, unsupported refusal and Cloud isolation. Run `node scripts/test-public-course-sources.mjs` for a bounded read-only current public-source check without model calls. If anonymous GitHub API limits prevent refresh, `PUBLIC_COURSE_GITHUB_CLI=1` uses your existing GitHub CLI connection only for these public reads; the application remains unauthenticated/fail-closed. The output distinguishes transports. A live public-source check verifies retrieval, not model answer quality. Synthetic results do not establish real model quality, real speech or physical hardware acceptance, or acceptance of an operator's deployment. Results from a private deployment do not establish those properties for LAITA Public V1.

Provide validation evidence for each revision, including applicable build, tests, policy and security checks. Review findings must be fixed or supported by a concrete disposition. Substantive changes require maintainer review and approval before merge; passing checks do not authorize deployment or release.

## Startup and boundary regressions

Fatal startup closes allocated work/input/speech/server and persistence resources, emits only bounded diagnostics and returns failure to the process manager. Ordinary failures exit naturally; a two-second unreferenced deadline forces exit code 1 if another referenced handle remains. Source and built entrypoints test actual port-bind errors and a synchronous post-initialization exception, with/without a synthetic persistent handle, SQLite close and temporary speech-artifact cleanup. Existing LaunchAgent tests preserve nonzero-exit keepalive and its bounded restart budget. Immediate `process.exit` is not used before cleanup/diagnostic draining; see [Node process exit semantics](https://nodejs.org/docs/latest-v24.x/api/process.html#processexitcode).

Control results accept own data properties rather than inherited fields/accessors; regressions verify hostile getters are not executed. History range filters use canonical UTC millisecond text, matching SQLite ordering, and reject normalized invalid calendar dates. Audio Blob construction snapshots only the received typed-array view into an ordinary ArrayBuffer, supports the current TypeScript BlobPart contract, clears the received bytes and revokes playback URLs on reset. Synthetic tests cover both ordinary/shared backing buffers without leaking surrounding bytes. These checks do not access real operator History, keys or speech devices.

## Reference HTTPS composition

`npm run test:reference-edge` (after build) exercises the shipped Caddyfile with the actual typed browser client and API. It is required by full validation and runtime compatibility CI, not skipped when Caddy is missing. Install Caddy 2.11.6 separately for local validation; CI downloads the official release into isolated tooling and verifies its pinned SHA-512 checksum.

The test changes only temporary ports and CA storage/trust installation. Its private test CA is trusted only by the test HTTPS client; it does not install system trust or use real runtime data, credentials or models. Tests verify independent A/B sessions, reset isolation, global BUSY/no-queue admission, shared History, exact Host/Origin rejection and edge-controlled forwarding metadata.

## v0.2.0: Owner roles and Canvas

Deterministic synthetic tests cover Owner credential initialization/rotation and no default password; standalone Admin/Teacher/Student; cookie and input-session binding; role/context History list/detail/write restrictions; valid signed Instructor launch; wrong user/course/role/origin/key; invalid signatures, alternate signature methods and duplicate fields; stale/future timestamps; persistent replay protection; unavailable/disabled configuration; and Canvas Teacher denial at Admin controls. Existing chat, grounding, provider, History, speech and reference-edge tests run through initialized role sign-in. The additive v5 migration retains the v1–v4 checksums and legacy records, with legacy History restricted to local Admin.

These results do not establish interoperability with a live Canvas instance. Real course App installation/removal, Canvas substitutions/Origin, new-window cookie behavior and browser private-network/loopback policy remain NOT_RUN unless a revision-specific public-safe result explicitly records them. Existing real models/speech/hardware acceptance limits still apply. The Owner-authorized v0.2.0 sandbox demo has a [provenance/privacy record](SCREENSHOTS.md); it does not replace revision-specific environment acceptance. Antigravity, Gemini and CI findings/status belong in the focused PR; missing reviews are not passing results. Validation and demo media do not authorize merge, tag, release or deployment.

## Canvas Page authoring

The synthetic API tests exercise credential file permissions, signed Teacher isolation, Unicode and HTML validation, mismatch and expiry of a preview, changed REST credentials and course identity, concurrent confirmation, and exact creation/readback or an uncertain result. Canvas calls use an injected provider. Live Canvas REST permissions and end-to-end behavior in an operator’s course require a separate acceptance check.

## Canvas Assignment authoring

The fake Canvas REST adapter covers unpublished creation and title-only editing on approved IDs. API tests check the read-only preview, exact course, identity and group or assignment ID, one-time confirmation, target drift, cancellation before dispatch, readback mismatch and ambiguous writes without replay. Synthetic desktop and phone Chromium scenarios exercise both flows alongside Page creation.

## Canvas Module authoring

The synthetic API tests cover empty unpublished creation and appending one approved Page or supported Assignment. They exercise disabled and unauthorized access, the shared rate limit and confirmation, module and item scope, partial responses, changed item inventory and resource, cancellation before write, and unverified or uncertain results. Desktop and phone Chromium scenarios exercise creation, linking both item types, and cancelling a preview. Live Canvas, native Safari and physical-device acceptance require separate validation.

## Canvas Chat plugin

The synthetic API exercises optional configuration, signed Teacher course and identity, exact-title ambiguity, fixed Test Student membership and submission requests, and rejection of mismatched accounts or unsupported assignment evidence. It covers submitted, absent, missing, excused, ungraded and current or stale score states, as well as rate limiting, access drift and cancellation. Desktop and phone Chromium exercise the count, score and unsupported-question response alongside standalone Chat and other Teacher tools. Canvas calls use a synthetic provider. Live Canvas interoperability and access permissions require separate acceptance.

## Canvas Teacher feedback

The synthetic API checks opt-in, signed Teacher and rate limits, exact Test Student and submission identity, Unicode and UTF-8 bounds, read-only preview, changed attempt or credential, expiry and cancellation before dispatch. It verifies the exact comment-only form, plain-text escaping, one-use confirmation and independent readback. It covers already-posted submissions, manual posting and rejection when a comment could post an unposted submission. Missing or mismatched receipts and readbacks yield uncertain or unverified results without another write. Desktop and phone Chromium exercise the exact plain-text preview, cancellation, explicit Post and readback alongside the other Teacher tools. Live Canvas permissions, notification behavior, native Safari and physical-device acceptance require separate validation.
