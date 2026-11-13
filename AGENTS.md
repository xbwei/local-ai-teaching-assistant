# Agent Instructions — LAITA Public

## Scope

This is a public repository. Keep all work public-safe, repository-focused, and limited to the controlling Issue.

Before substantive work, read the current Issue, this file, relevant code/tests/docs, any open PR for the work, and current CI/review state. Use an independent branch/worktree from the intended current base. Never add credentials, private institutional configuration, private repository content, student/participant data, restricted research data, runtime databases/logs/backups, or other non-public operational material.

## Development workflow

For formal tracked work:

1. Start from the intended current base and keep one coherent Issue/PR scope.
2. Make the smallest maintainable, testable, reversible change that satisfies the Issue.
3. Run all applicable deterministic build, test, type, lint/format, security/dependency, repository-policy, and public-sanitization checks.
4. Self-review the complete diff against the fresh intended base.
5. Follow the ChatGPT-assigned review profile. For any of the four reviewed profiles, complete the required exact-final-substantive-HEAD Antigravity review **before opening the PR**, unless the Owner has recorded an explicit scoped exception under Governance authorship below. Record `SKIPPED_BY_POLICY` only for explicitly assigned `NO_ANTIGRAVITY`. Missing, pending, or ambiguous profiles **block** this gate and do not authorize a skip.
6. Open a focused PR only after its assigned review profile and required pre-PR gates are satisfied or specifically waived by the Owner; never commit or push directly to main.
7. Let GitHub CI and Gemini review the exact submitted HEAD; address substantive findings and rerun affected validation.
8. Stop for final ChatGPT / Owner review and the Owner's explicit merge decision.

Do not create churn for duplicate, false-positive, style-only, or technically inapplicable review comments. Record a concise evidence-based disposition instead.

## Governance authorship and explicit exceptions

The Owner and ChatGPT author substantive changes to `AGENTS.md` and review policy through separate governance branches/PRs. Codex remains the implementation agent; it may identify policy problems and provide evidence or execute validation/review, but must not decide or amend its own governing policy to unblock work. Reviewer models review independently; they do not replace Codex as the routine implementation agent.

Governance changes follow the currently effective main policy, not their proposed rules. Only an explicit Owner decision recorded in the controlling Issue/PR may waive a named gate for a defined scope. Record an Antigravity waiver as `NOT_RUN / OWNER_AUTHORIZED_EXCEPTION`, with its authority and scope, never as PASS or `SKIPPED_BY_POLICY`. Authorship alone grants no exemption. A waiver does not transfer to other PRs or in-flight work; applicable validation, public-boundary checks, CI, exact-HEAD Gemini and the Owner's separate merge decision remain required.

## Risk-based Antigravity review policy

**ChatGPT assigns the provisional review profile in the controlling Issue or explicit Owner-approved handoff. Codex develops the change, inspects the complete final substantive diff, selects a qualified actual model/effort within that profile, and executes review.** Codex reports `RISK_ESCALATION_REQUIRED` with exact affected code, concrete impact and available models if the final diff exceeds the profile. ChatGPT adjudicates; Codex cannot downgrade or waive its assigned level. Missing or ambiguous profiles block the review/PR gate.

Choose by actual authority changes, consequences, reversibility and uncertainty, not a file name, security keyword or line count alone. A small session-lifetime change still changes credential authority; a cosmetic label does not. These routes allocate review effort, not guarantees that a model finds every bug.

**`NO_ANTIGRAVITY` is a separate skip state, not one of the four reviewed profiles.** It requires an explicit ChatGPT assignment for genuinely non-behavioral documentation/copy/cosmetic work with no runtime, security, privacy, data-contract or acceptance change. Preserve applicable validation, CI, public-boundary checks and Gemini. Record `SKIPPED_BY_POLICY`, never an Antigravity PASS.

### Four reviewed profiles

- **`STANDARD_ANTIGRAVITY`**: Ordinary bounded features, routine bugs, UI behavior and read-only logic without material authority or sensitive-state changes. Default: **Gemini 4 Hydrogen Medium**, effort **medium**.
- **`ELEVATED_ANTIGRAVITY`**: Difficult but bounded non-authority-changing logic, parsing, validation or state handling needing more scrutiny than STANDARD. Default: **Gemini 4 Hydrogen High**, effort **high**. Localized permission checks or concurrency work fit here only if they do not change authority, isolation or material resource/recovery guarantees. Those changes remain HIGH or above; ELEVATED is not a quota-driven way around high-risk triggers.
- **`HIGH_ASSURANCE_ANTIGRAVITY`**: Material authentication/session/credential semantics, Canvas course identity, student/participant privacy or isolation, authorization, durable production state/transactions/migration, external writes, deployment/security boundaries, or consequential concurrency, cancellation, resource-limit and recovery changes. Default: **Gemini 4 Argon Medium**, effort **medium**. A bounded session-lifetime change belongs here; HIGH does not automatically require Argon High.
- **`CRITICAL_ANTIGRAVITY`**: New or substantially redesigned authentication or authorization, major credential/privacy/security architecture, high-impact destructive migration/recovery, or broad review-gate redesign where failure has unusually large consequences or is difficult to contain or reverse. Default: **Gemini 4 Argon High**, effort **high**. Not every governance edit or production-related file automatically belongs here; justify the actual risk.

Codex verifies the installed model ID/effort and uses the assigned route or a permitted qualified fallback; it does not silently change tiers. Existing NO/STANDARD/HIGH identifiers remain valid. Do not retroactively invalidate historical evidence or reclassify in-flight work because new tiers exist.

### Qualified fallback

- After verified Hydrogen quota exhaustion, STANDARD may use restricted-protocol-qualified **Gemini 3.8 Flash Medium**, or **Claude Sonnet 5.5 Medium** within an approved third-party quota budget. Do not automatically consume that budget.
- After verified Argon quota exhaustion, HIGH may use qualified **Claude Opus 5.5 Medium/High** or **Claude Sonnet 5.5 High** within the approved budget. Hydrogen and Flash do not substitute for HIGH or CRITICAL.
- ELEVATED and CRITICAL alternatives require an explicit task-specific ChatGPT/Owner-approved route before invocation; do not infer them from another tier's whitelist. Opus and Sonnet share third-party quota. If no permitted qualified reviewer is available, record `BLOCKED / NOT_RUN`; no paid overages.

Only confirmed model-quota unavailability allows a permitted fallback. Generic HTTP 429, capacity/transport error, protocol/permission failure, timeout or adverse findings are not evidence for downgrading. Record the assigned profile, requested/actual model, effort, exact base/HEAD, review result and fallback/exception authority. Do not repeatedly spend quota on an unchanged diff.

### Model integrity and transition

Always verify the specific installed `agy` model ID and effort, explicit requested/actual identity, plan/sandbox/read-only permissions and effective no-tools restrictions, including negative-path evidence. No file reads/writes, shell/commands, URL/network access, MCP/skills/delegation expansion or silent fallback. A model promise or zero observed tool calls alone is not qualification. Use an already verified transport for the complete fresh-base-to-final-HEAD diff; reject stale, empty or truncated evidence. Record exact coverage and structured review results, not raw transcripts.

A UI model label or an AGENTS.md edit does not prove that the installed CLI, wrapper, reviewer schema or agent supports a route. Verify the actual setup before using it; unqualified candidates remain `BLOCKED / NOT_RUN`, not PASS. Proposed rules take effect only after Owner-authorized merge. A governance PR cannot use its candidate policy to waive the effective gate; any exception must come from an explicit external Owner decision. Existing in-flight obligations are not automatically waived, and changed base/HEAD requires fresh applicable evidence rather than a transferred PASS.

Do not save or commit raw review transcripts. After any substantive change, refresh affected tests and every review that the assigned profile requires; do not repeat low-yield calls on an unchanged HEAD.

## GitHub CI and Gemini

After the PR is opened:

- wait for configured CI/security checks;
- let the normal Gemini review run on the exact submitted substantive HEAD;
- verify the reviewed HEAD and any pending automatic/manual request before requesting a review;
- never request duplicate Gemini review for the same exact substantive HEAD;
- after a substantive fix, repeat required validation and any profile-required Antigravity review for the new exact HEAD, then obtain fresh exact-HEAD CI/Gemini evidence.

The final substantive HEAD must have required validation, profile-applicable Antigravity evidence (or honest `SKIPPED_BY_POLICY` / scoped `NOT_RUN / OWNER_AUTHORIZED_EXCEPTION`), CI and Gemini evidence before merge review. The skip and exception states are not review PASS results.

## PR handoff

Record:

- exact final HEAD SHA and intended base;
- validation results;
- Antigravity exact-HEAD result, actual model/effort, or precisely scoped skip/exception authority;
- GitHub CI result;
- Gemini exact-HEAD result and finding dispositions;
- honest `NOT_RUN` checks and known limitations;
- rollback or migration impact when relevant.

A passing review or CI result is not merge authority.

## Public repository boundaries

Use only synthetic, public, contributor-owned, or explicitly distributable fixtures. Do not hard-code machine-specific paths, authentication state, secrets, private host/network identifiers, or deployment-only details.

Keep public claims consistent with executable behavior and validated evidence. Do not introduce unrelated infrastructure, live access, or broader product scope without a separate controlling Issue and Owner decision.

## Authority

Only the Owner may authorize merge, tag/release publication, deployment, live/institutional configuration changes, or credential changes. Merge, release, and deployment are separate decisions.
