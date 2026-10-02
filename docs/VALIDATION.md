# Candidate validation

Use Node 24.16.0/npm 11.13.0, Caddy 2.11.6 and Python 3.12.14/uv 0.12.7 for deterministic gates. `npm run validate` installs locked dependencies and runs build, typecheck, import boundaries, formatting, Node/API/provider/history/speech/grounding/ops tests, process/workspace smoke, Python architecture fixtures, npm/uv audits, lockfile/runtime-cleanliness negatives and policy-contract/schema checks.

The compatibility gate uses Node 24.19.0/npm 11.17.0 and runs runtime/persistence/API/smoke validation. CI also checks actionlint, Git-history secrets using offline TruffleHog and Semgrep CE JavaScript/Python rules. Scans do not use paid AI/security services. CodeQL/push protection/hosted secret scanning are publication-stage evaluations and are not claimed enabled here.

Opt-in browser validation: set `PLAYWRIGHT_MODULE` to your installed Playwright module and run `node scripts/test-browser-client.mjs` after build. It uses synthetic HTTPS/providers/audio/storage, not real model requests or physical microphones. The reference HTTPS configuration must be validated too. Fresh-clone setup smoke must use only LAITA files and isolated operator-owned runtime.

Synthetic golden retrieval tests cover bilingual overview, Lab/Week locators, exact displayed evidence, active-context preservation, unsupported refusal and Cloud isolation. Run `node scripts/test-public-course-sources.mjs` for a bounded read-only current public-source check without model calls. If anonymous GitHub API limits prevent refresh, `PUBLIC_COURSE_GITHUB_CLI=1` uses your existing GitHub CLI connection only for these public reads; the application remains unauthenticated/fail-closed. The output distinguishes transports. Do not confuse synthetic results with live model quality or extrapolate a private deployment's results to this candidate.

Provide validation evidence for the final revision, including applicable build, tests, policy and security checks. Review findings must be fixed or supported by a concrete disposition. Substantive changes require maintainer review and approval before merge; passing checks do not authorize publication, visibility changes, deployment or release.

## Startup and boundary regressions

Fatal startup closes allocated work/input/speech/server and persistence resources, emits only bounded diagnostics and returns failure to the process manager. Ordinary failures exit naturally; a two-second unreferenced deadline forces exit code 1 if another referenced handle remains. Source and built entrypoints test actual port-bind errors and a synchronous post-initialization exception, with/without a synthetic persistent handle, SQLite close and temporary speech-artifact cleanup. Existing LaunchAgent tests preserve nonzero-exit keepalive and its bounded restart budget. Immediate `process.exit` is not used before cleanup/diagnostic draining; see [Node process exit semantics](https://nodejs.org/docs/latest-v24.x/api/process.html#processexitcode).

Control results accept own data properties rather than inherited fields/accessors; regressions verify hostile getters are not executed. History range filters use canonical UTC millisecond text, matching SQLite ordering, and reject normalized invalid calendar dates. Audio Blob construction snapshots only the received typed-array view into an ordinary ArrayBuffer, supports the current TypeScript BlobPart contract, clears the received bytes and revokes playback URLs on reset. Synthetic tests cover both ordinary/shared backing buffers without leaking surrounding bytes. These checks do not access real operator History, keys or speech devices.

## Reference HTTPS composition

`npm run test:reference-edge` (after build) exercises the shipped Caddyfile with the actual typed browser client and API. It is required by full validation and runtime compatibility CI, not skipped when Caddy is missing. Install Caddy 2.11.6 separately for local validation; CI downloads the official release into isolated tooling and verifies its pinned SHA-512 checksum.

The test changes only temporary ports and CA storage/trust installation. Its private test CA is trusted only by the test HTTPS client; it does not install system trust or use real runtime data, credentials or models. Tests verify independent A/B sessions, reset isolation, global BUSY/no-queue admission, shared History, exact Host/Origin rejection and edge-controlled forwarding metadata.
