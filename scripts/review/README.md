# Public reviewer entrypoint

Run from this public repository and the approved published Cloud environment.
This is a thin independent exact-diff review helper. It does not install or change
Antigravity, handle credentials, assign review profiles, or authorize merges.

## Commands

Before any Antigravity invocation, including environment initialization:

```sh
export AGY_CLI_DISABLE_AUTO_UPDATE=true
```

Initialize and activate the environment using its supplied instructions. Then:

```sh
node scripts/review/review.mjs inspect
git fetch origin main
BASE=$(git rev-parse origin/main)
HEAD=$(git rev-parse HEAD)
node scripts/review/review.mjs prepare "$BASE" "$HEAD" HIGH_ASSURANCE_ANTIGRAVITY
node scripts/review/review.mjs review "$BASE" "$HEAD" HIGH_ASSURANCE_ANTIGRAVITY
```

`inspect` prints machine-independent executable/artifact hashes, requested
model/effort, Node version and policy hash. Discovery resolves symlinks and
recognizes only the published simple forwarding shim. The canonical ELF hash and
version must match `route.json`; unknown shims and CLI identity changes block.
`AGY_EXECUTABLE` can locate the installed executable but cannot bypass that check.
Never replace or repin the executable to satisfy a check.

`route.json` contains invocation configuration and limits, not a qualification
registry. The supported profile remains `HIGH_ASSURANCE_ANTIGRAVITY`, requesting
`gemini-4-argon-high` / high under the published workspace instructions. Other
profiles/routes are unsupported; there is no automatic fallback.

`prepare` requires full commit IDs, a clean checkout including untracked files,
HEAD equal to the supplied commit, and a base equal to both origin/main and live
remote main. The base must be an ancestor of HEAD. Its binding includes both
trees, changed paths, complete diff byte count and SHA-256. The diff includes
binary patches and deletions, disables external diff/text conversion, and has no
path filter. Empty, oversized or unsupported-encoding diffs block without
truncation. Preparation does not invoke review or print the diff.

`review` requests the repository-owned restricted agent, explicit model/effort,
plan mode through `settings.json`, sandbox, disabled slash expansion and deny-all
settings. CLI 1.5.1 warns that the redundant `--mode plan` flag has no effect with
slash expansion disabled, so the helper uses the supported `agentMode: "plan"`
setting instead. The agent
requests no tools, skills, plugins, MCP or delegation. Ambient customizations
block; provider and credential environment overrides are excluded.

The helper checks the native init's reported model, agent, strict permission mode
and schema. It writes exactly one stdin user message containing the complete diff,
schema, binding and effective base policy, waits for the result, then closes stdin.
The native schema is loaded from a temporary file. Large payloads never become
command-line arguments. Streaming JSON output preserves tool-event monitoring.
Advertised tool inventory is not tool
execution and is not compared to a stored or empty inventory. Supported
user/agent/checkpoint steps must keep the same conversation. Tool/delegation
steps, including denied attempts, unknown events, protocol/CLI failure, incomplete
output, invalid results or observed route mismatches block. The CLI’s exact notice
that slash commands were not expanded is expected; every other nonempty diagnostic
blocks, including permission notices.
The process is bounded by `route.json`'s ten-minute timeout.

An explicitly present terminal `structured_output` is always parsed and validated,
whether object or serialized JSON; invalid/adverse terminal output cannot be
replaced by cached text. Conflicting complete structured responses block. Only
when that field is absent may the helper use the final completed (`DONE`)
`agent_response` step’s `text_delta` chunks, or the terminal JSON response when
there is no streamed text. It records the selected `reported.resultSource`
and validates the exact result schema and diff binding. PASS also
requires complete coverage and no findings. Valid FINDINGS/BLOCKED results remain
adverse results, not PASS. Before accepting the result, the helper rechecks fresh
base, HEAD/clean state, diff and executable/artifact identity. PASS exits 0;
adverse results and failures exit 2.

## Requested and reported information

The receipt distinguishes `requestedModel` / `requestedEffort` from `reported`
native model, effort, agent and permission mode. The supported CLI
[headless protocol](https://antigravity.google/docs/cli/headless/) reports model,
agent and permission mode at init. It does not normally supply a separate effort
field: `reported.effort` is then `null`, not an invented observation. If an effort
value is reported and differs from the request, the review blocks.

Under the controlling [Issue #67](https://github.com/xbwei/local-ai-teaching-assistant/issues/67),
missing unsupported effort/sandbox/no-tools attestation fields are not a reason
to stop before sending input. This helper uses supported configuration and
reported information, and blocks observed violations. Its result is a code
review, not runtime certification. Stream rejection detects an event; it cannot
undo a tool that already executed.

No persistent qualification certificate, session registry or fresh-session probe
ceremony is required. Historical NOT_ESTABLISHED evidence is not relabeled PASS.
The wrapper saves no raw transcript or native stderr. It prints only the bounded
structured review receipt or a fixed failure code. Native authentication and
session storage remain the CLI's responsibility.

## Verification

```sh
node --test scripts/ci/reviewer-route.test.mjs
npm run validate
```

Deterministic tests cover successful and adverse streams, complete prompt
transport, result/conversation binding, prohibited events, drift, truncation and
CLI failures using synthetic repositories and child processes. They do not
substitute for the real exact-diff review required by #67. For this reviewer-tooling
transition, retain bounded functional verification, GitHub CI, exact-HEAD Gemini,
DOT independent complete-diff review and ChatGPT/Owner review under current
[AGENTS.md](../../AGENTS.md). Issue-level acceptance and closure remain with ChatGPT.
