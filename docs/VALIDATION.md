# Candidate validation

Use Node 24.16.0/npm 11.13.0 and Python 3.12.14/uv 0.12.7 for deterministic gates. `npm run validate` installs locked dependencies and runs build, typecheck, import boundaries, formatting, Node/API/provider/history/speech/grounding/ops tests, process/workspace smoke, Python architecture fixtures, npm/uv audits, lockfile/runtime-cleanliness negatives and policy-contract/schema checks.

The compatibility gate uses Node 24.19.0/npm 11.17.0 and runs runtime/persistence/API/smoke validation. CI also checks actionlint, Git-history secrets using offline TruffleHog and Semgrep CE JavaScript/Python rules. Scans do not use paid AI/security services. CodeQL/push protection/hosted secret scanning are publication-stage evaluations and are not claimed enabled here.

Opt-in browser validation: set `PLAYWRIGHT_MODULE` to your installed Playwright module and run `node scripts/test-browser-client.mjs` after build. It uses synthetic HTTPS/providers/audio/storage, not real model requests or physical microphones. The reference HTTPS configuration must be validated too. Fresh-clone setup smoke must use only LAITA files and isolated operator-owned runtime.

Synthetic golden retrieval tests cover bilingual overview, Lab/Week locators, exact displayed evidence, active-context preservation, unsupported refusal and Cloud isolation. Run `node scripts/test-public-course-sources.mjs` for a bounded read-only current public-source check without model calls. If anonymous GitHub API limits prevent refresh, `PUBLIC_COURSE_GITHUB_CLI=1` uses your existing GitHub CLI connection only for these public reads; the application remains unauthenticated/fail-closed. The output distinguishes transports. Do not confuse synthetic results with live model quality or extrapolate a private deployment's results to this candidate.

Required review order: deterministic/security → complete diff self-review → sandboxed, tool-denied Antigravity with explicit Gemini model and exact HEAD → PR/CI → exact-HEAD Gemini/fix-disposition loop → ChatGPT complete PR review → Owner. Substantive changes stale applicable checks/reviews. No result authorizes merge, visibility change, deployment or release.
