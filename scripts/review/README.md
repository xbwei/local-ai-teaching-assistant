# Public reviewer entrypoint

Run from the public repository with the approved published Cloud environment.
This tooling does not install or change Antigravity, handle credentials, assign
review profiles, authorize merges, or substitute for repository policy.

**Bootstrap state: UNQUALIFIED.** Issue #67's implementation tests are not runtime
qualification. Production `review` blocks before inference while this marker is
present. Two independent Public Cloud sessions must supply reviewed native evidence before
the qualification record changes. The observation harness below never writes that
record or enables production review.

## Commands

Before any manual Antigravity invocation, including environment initialization:

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

`inspect` prints only machine-independent executable/artifact hashes and requested
model/effort, Node version and governing policy hash. It is not qualification.
Discovery searches PATH, resolves symlinks,
and recognizes only the published simple cache-setting forwarding shim. It hashes
the canonical ELF before invoking `--version`; unknown shims and identity changes
block. `AGY_EXECUTABLE` may name the canonical installed executable when PATH does
not expose it. It cannot bypass the hash check. Never replace or repin the binary
to satisfy this check.

`prepare` requires full commit IDs, a clean checkout including untracked files,
HEAD equal to the supplied commit, and a base equal to both origin/main and the
current remote main. The base must be an ancestor of HEAD. Its receipt binds both
trees, changed paths, exact diff byte count and SHA-256. The diff includes binary
patches and deletions, disables external diff/text conversion, and is not filtered
by path. Empty, oversized, or unsupported-encoding inputs block rather than being
truncated. `prepare` is not review. It deliberately does not print the raw diff.

`review` additionally requires the same reviewed qualification record and reviewer
implementation in the base and checkout. A candidate PR cannot qualify its own
changed reviewer. The whole serialized diff, binding and effective base policy go
in one stdin message only after stream initialization matches the qualified route.
The schema fixes the expected binding. Unknown events, tool/delegation events
(even denied attempts), nonempty diagnostics, protocol drift, timeouts, malformed
or incomplete output fail closed. Base, HEAD, clean state and route are checked
again before reporting the result. Non-PASS results exit 2.

No raw review output or native stderr is written by this wrapper. Only the bounded
structured finding receipt is printed. The native CLI retains responsibility for
its own authentication and native session storage. Do not publish that storage.

## Qualification boundary

The currently installed version/hash are an observed candidate identity, not an
assertion of qualification. The initial route requests Argon High/high because
the published workspace instructions explicitly require Argon High; the assigned
profile remains HIGH_ASSURANCE. Repository policy's default for that profile is
Argon Medium/medium. Resolve any change through Owner/ChatGPT authority, not an
automatic model fallback. Other routes/profiles are currently unsupported.

Independent fresh-session qualification must establish:

- Actual model/effort resolution and rejection of invalid model/effort requests.
- Effective plan, sandbox/read-only and deny-all behavior, including attempted
  file reads/writes, shell, URLs/network, MCP, skills and delegation.
- Correct agent loading; an empty `agy agents` list is not proof of failure.
- Complete-diff transport, including late content and binary/change coverage,
  nontruncation, structured output and adverse-result handling.
- Material CLI, agent, settings, schema, wrapper and tool-inventory drift rejection.

The existing no-prompt diagnostics did not establish these properties. In
particular, an advertised tool inventory is neither permission enforcement nor a
bypass. Strict permissions and zero observed tool calls alone are insufficient.
Stream rejection detects violations; it does not prevent an already executed
tool. The qualified native route must enforce restrictions before any tool runs.

The qualification record is a reviewed attestation, not self-authenticating proof.
Its authority and two distinct session evidence references must point to public
Issue/PR comments reviewed under existing policy. Each session must cover all ten
categories enforced by `assertQualified`. The expected tool inventory is recorded
only after actual negative-path qualification; it is not inferred from the
current init event. Store no raw transcripts or machine paths in the record.

There is deliberately no `--force`, automatic qualification, model fallback, or
per-PR qualification command. A future reviewed record can enable only its exact
route fingerprint. Unchanged qualified routes perform identity/binding checks and
ordinary review without repeating full qualification. Changed routes fail closed
and require separate qualification. If native protocol evidence cannot support
the contract, keep the route unqualified and report the precise limitation.

## Bounded qualification observations

Issue #67's qualification-enablement follow-up adds `qualify.mjs`. This is an
observation harness, **not a certification command**. It deliberately returns
`NOT_ESTABLISHED`, or `BLOCKED` on an observed failure (exit 2), until
authoritative native evidence can support each
required property. Its receipts cannot be supplied to `assertQualified`.
Production `review`, `assertQualified`, and base-record trust are unchanged.

From a clean exact candidate checkout, after environment initialization with
auto-update disabled, DOT may resume each existing independent session:

```sh
git fetch origin main
BASE=$(git rev-parse origin/main)
HEAD=$(git rev-parse HEAD)
node scripts/review/qualify.mjs modelEffort SESSION_ID "$BASE" "$HEAD"
```

Use the actual existing session ID. Run one selected probe at a time; inspect its
receipt before continuing. There is no automatic suite or retry. Other probe names
are `invalidModel`, `invalidEffort`, `agentLoading`, `fileRead`, `fileWrite`,
`shell`, `network`, `mcp`, `skills`, `delegation`, and `completeDiff`. Stop on a
capability event, side effect, diagnostic, timeout, protocol failure or drift;
do not continue spending inference quota through an unresolved failure. Native
probes are not CI tests. DOT coordinates the A/B runs; do not create duplicate
sessions or publish raw native output.

The harness shares production argument construction, executable identity checks,
ambient-customization rejection, environment filtering, agent contents, settings,
schema and strict stream validator. It binds the clean candidate base/HEAD,
route fingerprint and harness hash before and after invocation. Changed shared
reviewer code changes the route hash: earlier CLI identity observations remain
useful, but do not qualify this changed route. Compare inventory digests between
independent receipts; the first observed inventory is not a trusted inventory.

Each probe gets a temporary synthetic workspace. File targets contain only random
synthetic text; shell requests only print a fixed string; the URL is loopback port
1; MCP, skill and agent targets deliberately do not exist. The latter probes
cannot distinguish unavailable capabilities from native permission enforcement.
No servers, skills or agents are enabled to make those tests succeed. The
complete-diff probe supplies a large generated diff with addition, deletion,
binary content and a late defect carrying an unpredictable marker. Its bounded
receipt records structured-result validation and whether the late marker was
returned in a finding. Neither observation alone proves complete model coverage.

`modelEffort` uses the documented CLI-native standalone `/model` report, with
unchanged restrictions. It removes only the stream-input and schema-output flags,
selects text output, and retains agent/model/effort, plan, sandbox, disabled slash
expansion, settings and log-suppression flags. CLI 1.5.1 rejects `--json-schema`
with text output; a standalone text diagnostic is not a schema-constrained review.
Invalid-parameter probes use that same diagnostic rather
than an inference prompt. Mentions of the requested model/effort are recorded as
hints only. No report text is retained. The installed headless protocol documents
model/agent selection and generic tool errors, but does not specify an
execution-bound actual-effort attestation or a typed, pre-execution permission
denial proof. Generic process failure cannot prove invalid-parameter rejection;
a model refusal, missing target, tool error, or zero tool calls cannot prove
restrictions. All remain `NOT_ESTABLISHED`. Unknown diagnostics are not interpreted
as quota exhaustion or permission denial. A nonzero diagnostic exit or signal
termination is `BLOCKED / NATIVE_EXIT_FAILED`, even for invalid-parameter probes;
failed diagnostics do not produce model/effort hints. Earlier specific failures
remain the reported cause. Inference probes abort on any tool or
delegation event, including an alleged denial; stream rejection is detection,
not prevention of a native tool already executed.

Only bounded booleans, counts, hashes, fixed codes and candidate/session identifiers
are emitted. `validateEvidence` rejects arbitrary native fields and affirmative
qualification claims. The CLI retains responsibility for its native session
storage; the harness never reads or publishes it. No transcript, error message,
account identifier, absolute path or model finding enters receipts.

Remaining acceptance work is explicit: establish supported authoritative evidence
for actual model/effort, agent loading and enforced negative paths; independently
review both sessions' evidence and material drift; then review and commit the final
qualification record under Issue #67 authority. If the native protocol cannot
supply a property, preserve the blocker and seek the specific adjudication. Do not
weaken a gate or expand permissions to manufacture evidence.

## Deterministic verification

```sh
node --test scripts/ci/reviewer-route.test.mjs scripts/ci/reviewer-qualification.test.mjs
npm run validate
```

The Node test suite uses synthetic Git repositories, files and mocked protocol
events. It does not invoke a model, prove independent sessions, exercise native
permission denials, or establish actual model effort. Full validation and normal
GitHub CI/Gemini remain separate required gates. Issue #67's scoped bootstrap
exception is recorded as `NOT_RUN / OWNER_AUTHORIZED_EXCEPTION`, never PASS or
SKIPPED, and does not qualify this route for ordinary PRs.

References: [CLI headless protocol](https://antigravity.google/docs/cli/headless/),
[CLI permissions](https://antigravity.google/docs/permissions?tab=cli),
[agent discovery](https://antigravity.google/docs/customization-discovery/),
[settings schema](https://antigravity.google/schemas/v1/settings.json).
