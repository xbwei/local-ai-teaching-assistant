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
5. Complete the required Antigravity review on the exact final substantive HEAD **before opening the PR**.
6. Open a focused PR only after the Antigravity gate passes.
7. Let GitHub CI and Gemini review the exact submitted HEAD; address substantive findings and rerun affected validation.
8. Stop for final ChatGPT / Owner review and the Owner's explicit merge decision.

Do not create churn for duplicate, false-positive, style-only, or technically inapplicable review comments. Record a concise evidence-based disposition instead.

## Required Antigravity gate

Use the maintainer-configured Antigravity command `agy`.

Before declaring the gate unavailable:

- run `command -v agy`;
- run `agy --version`;
- use the CLI's model-listing command to confirm `gemini-4-argon-high` is available.

Use **`gemini-4-argon-high`** unless the Owner explicitly changes the required model.

Review the complete exact-final substantive diff in plan/sandbox/read-only mode with strict permissions:

- no file writes;
- no shell/command execution;
- no URL/network access;
- no MCP/tool expansion;
- no fallback model.

Do not save or commit raw review transcripts.

If `agy` or the required model is genuinely unavailable after those checks, record **BLOCKED / NOT_RUN**. Do not substitute another reviewer or open the PR as though the gate passed.

Any substantive change after Antigravity invalidates that review evidence. Rerun affected deterministic checks and repeat the complete-diff Antigravity review on the new exact HEAD before continuing.

## GitHub CI and Gemini

After the PR is opened:

- wait for configured CI/security checks;
- let the normal Gemini review run on the exact submitted substantive HEAD;
- verify the reviewed HEAD before manually requesting another review;
- never request duplicate Gemini review for the same exact substantive HEAD;
- after a substantive fix, repeat the required pre-PR-equivalent validation and Antigravity review for the new exact HEAD, then obtain fresh exact-HEAD CI/Gemini evidence.

The final substantive HEAD must have complete required validation, Antigravity, CI, and Gemini evidence before merge review.

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
