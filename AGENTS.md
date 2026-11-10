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
5. Follow the ChatGPT-assigned review profile. For explicitly assigned `STANDARD_ANTIGRAVITY` or `HIGH_ASSURANCE_ANTIGRAVITY`, complete the required exact-final-substantive-HEAD Antigravity review **before opening the PR**; record `SKIPPED_BY_POLICY` only for explicitly assigned `NO_ANTIGRAVITY`. Missing, pending, or ambiguous profiles **block** this gate and do not authorize a skip.
6. Open a focused PR only after its assigned review profile and required pre-PR gates are satisfied.
7. Let GitHub CI and Gemini review the exact submitted HEAD; address substantive findings and rerun affected validation.
8. Stop for final ChatGPT / Owner review and the Owner's explicit merge decision.

Do not create churn for duplicate, false-positive, style-only, or technically inapplicable review comments. Record a concise evidence-based disposition instead.

## Risk-based Antigravity review policy

This policy is shared with the other actively maintained projects, regardless of whether a coordinating Dot exists. **ChatGPT assigns the provisional review level in the controlling Issue or explicit Owner-approved handoff. Codex develops the change, inspects the complete final substantive diff, selects the actual model/effort inside the approved level, and executes the review.** Codex may report `RISK_ESCALATION_REQUIRED` with evidence but may not downgrade or waive a level assigned by ChatGPT; ChatGPT adjudicates escalation. If a task has no assigned level, request one before using the gate or opening a PR.

- **`NO_ANTIGRAVITY`**: Documentation, copy, or cosmetic-only UI with no runtime, security, privacy, data-contract, or acceptance behavior change. Preserve applicable validation, CI, public-boundary checks and GitHub Gemini. Record `SKIPPED_BY_POLICY`, never a fabricated Antigravity PASS.
- **`STANDARD_ANTIGRAVITY`**: Ordinary bounded implementation and read-only functionality. Prefer **Gemini 4 Argon Medium**. On verified Argon quota exhaustion, use a restricted-protocol-verified **Claude Sonnet 5.5 Medium** (High only if the diff warrants it), preserving Opus for high-risk work. If Claude's shared quota is also unavailable or the preapproved quota budget is unsuitable, use **Gemini 3.8 Flash Medium**, but only after verifying the same restricted-review protocol for that model. Record each fallback reason; do not spend shared Claude quota on repeated low-yield reviews.
- **`HIGH_ASSURANCE_ANTIGRAVITY`**: Authentication/Canvas course identity, credentials, participant or student privacy boundaries, authorization, persistent state/transactions, migration, external writes, deployment, complex concurrency/recovery, resource limits, or changes to these review rules themselves. Prefer **Gemini 4 Argon Medium/High**, selecting effort according to actual complexity; when verified Argon quota is unavailable, **Claude Opus 5.5 Medium/High** or **Claude Sonnet 5.5 High** may be selected only if the installed CLI and the unchanged restricted protocol support them. If both Argon and qualified Claude are unavailable, report `BLOCKED / NOT_RUN`; Flash must not substitute for high assurance. Opus and Sonnet share third-party model quotas; avoid unnecessary retries.
- **Final-diff escalation:** Codex must check for the above high-risk triggers after implementing the diff. If any are newly present above the assigned level, stop the review handoff and submit `RISK_ESCALATION_REQUIRED` to ChatGPT, including exact affected code, impact and actual available models. Do not self-approve a lower tier to conserve quota.
- **Model integrity:** Always verify the specific installed `agy` model ID and effort using the CLI, explicit model selection, plan/sandbox/read-only permissions, with no file writes, no shell/command execution, no URL/network access, no MCP/tool expansion, and no silent fallback; maintain full diff and exact base/HEAD identity. Record requested and actual models, effort, quota/fallback reason, review result and exceptions. Only confirmed model-quota unavailability allows the approved fallback; do not treat generic HTTP 429, protocol/permission failure, timeout or adverse findings as proof that fallback is safe. If no qualified model is available, report `BLOCKED / NOT_RUN` and do not enable paid overages.
- **Transition:** This AGENTS.md-only policy does not prove that any existing CLI wrapper, model-verification schema, or local agent already supports alternate models. Check the actual setup and tests before invoking a fallback. Existing open work is not retroactively exempt from its prior review contract. This governance change itself requires independent review and Owner merge approval; do not use it to self-waive the pre-existing gate.

Do not save or commit raw review transcripts. After any substantive change, refresh affected tests and every review that the assigned profile requires; do not repeat low-yield calls on an unchanged HEAD.

## GitHub CI and Gemini

After the PR is opened:

- wait for configured CI/security checks;
- let the normal Gemini review run on the exact submitted substantive HEAD;
- verify the reviewed HEAD before manually requesting another review;
- never request duplicate Gemini review for the same exact substantive HEAD;
- after a substantive fix, repeat required validation and any profile-required Antigravity review for the new exact HEAD, then obtain fresh exact-HEAD CI/Gemini evidence.

The final substantive HEAD must have required validation, profile-applicable Antigravity (or honest SKIPPED_BY_POLICY), CI, and Gemini evidence before merge review.

## PR handoff

Record:

- exact final HEAD SHA and intended base;
- validation results;
- Antigravity exact-HEAD result and model;
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
