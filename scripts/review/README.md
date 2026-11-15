# Public reviewer entrypoint

Run from this public repository and the approved published Cloud environment.
This tooling does not install or change Antigravity, handle credentials, assign
review profiles, or authorize merges.

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
node scripts/review/review.mjs smoke "$BASE" "$HEAD" HIGH_ASSURANCE_ANTIGRAVITY
node scripts/review/review.mjs review "$BASE" "$HEAD" HIGH_ASSURANCE_ANTIGRAVITY
```

`inspect` prints machine-independent executable/artifact hashes, requested
model/effort, Node version and policy hash. It does not establish actual runtime
model/effort or review PASS. Discovery resolves symlinks and recognizes only the
published simple cache-setting forwarding shim. It hashes the canonical ELF
before invoking `--version`; unknown shims and CLI identity changes block.
`AGY_EXECUTABLE` may locate the installed executable but cannot bypass its hash
check. Never replace or repin the executable to satisfy a check.

`route.json` contains the expected CLI identity, requested model/effort and size/time
limits. It is invocation configuration, not a qualification registry. The current
request remains Argon High/high under the published workspace instructions;
the supported profile is `HIGH_ASSURANCE_ANTIGRAVITY`. Other profiles/routes are
unsupported. There is no automatic fallback.

`prepare` requires full commit IDs, a clean checkout including untracked files,
HEAD equal to the supplied commit, and a base equal to both origin/main and live
remote main. The base must be an ancestor of HEAD. Its receipt binds both trees,
changed paths, complete diff byte count and SHA-256. The diff includes binary
patches and deletions, disables external diff/text conversion, and has no path
filter. Empty, oversized or unsupported-encoding diffs block without truncation.
Preparation is not review and does not print the diff.

`smoke` checks the same binding and starts the restricted transport for at most
15 seconds. It never sends a prompt or accepts a review result. This is a bounded
startup check, not Antigravity self-review or permission qualification.

`review` uses the complete serialized diff, binding and effective base policy as
one stdin message only after runtime integrity is verified. It requests the
repository-owned agent with no tools, skills, plugins, MCP or delegation, plan
mode, sandbox and deny-all settings. Ambient customizations block; provider and
credential environment overrides are excluded. Base/HEAD, clean state, diff and
executable/artifact identity are rechecked before accepting any result.

## Runtime evidence limitation

The installed CLI 1.5.1 [headless protocol](https://antigravity.google/docs/cli/headless/)
documents startup model/agent selection, permission mode, tool inventory and
schema. It does not document execution-bound actual effort or effective
plan/sandbox/no-tools evidence. Requested flags, model assertions and an empty
tool inventory cannot fill that gap.

Consequently the current wrapper rejects even an otherwise matching startup
with `BLOCKED / RUNTIME_EFFORT_AND_RESTRICTIONS_UNVERIFIED`, before sending any
prompt. An advertised tool inventory is not itself a prohibited event or proof
of effective permissions; it is not compared to a stored or empty inventory.
Mismatched identity/schema, unknown events, tool events (including denied file, shell, network, MCP, plugin, skill or
delegation attempts), diagnostics, malformed output and timeouts also block.
There is currently **no supported native PASS path**. A supported authoritative
native evidence mechanism needs a separately reviewed implementation; adding
invented attestation fields or accepting requested settings is not a solution.
Stream rejection detects an event; it cannot undo a tool that already executed.

The structured result validator still rejects extra fields, incorrect binding,
incomplete PASS coverage and invalid findings. These deterministic checks do not
prove native runtime integrity. No raw review transcript or stderr is saved or
published by the wrapper; only bounded receipts and fixed error codes are emitted.
The CLI remains responsible for its own native authentication/session storage.

There is no persistent QUALIFIED/UNQUALIFIED certificate, session registry or
fresh-session probe ceremony. The obsolete harness and marker have been removed.
Historical `NOT_ESTABLISHED` evidence remains historical evidence, never PASS.
Unknown invocation evidence remains `BLOCKED / NOT_RUN`.

## Verification and reviewer-tooling transition

```sh
node --test scripts/ci/reviewer-route.test.mjs
npm run validate
```

Tests use synthetic Git repositories, files, native metadata and child processes;
they do not invoke a model or establish actual effort or permission enforcement.
For changes to this tooling, follow current [AGENTS.md](../../AGENTS.md):
deterministic tests, a bounded smoke check, GitHub CI, exact-HEAD Gemini, DOT's
independent complete-diff review and ChatGPT/Owner review. Antigravity does not
approve its own implementation; record its review as `NOT_RUN` under that
transition, never PASS or `SKIPPED_BY_POLICY`. Issue-level acceptance and closure
remain with ChatGPT.
