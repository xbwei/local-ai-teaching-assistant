# Agent Instructions — LAITA Public

## Purpose and scope

This public repository is the stable, sanitized distribution line for the individual/self-managed LAITA product. Work here must stay suitable for public release and must not depend on private JMU repositories, SCHOOL deployment details, institutional credentials, student data, private runtime state, or maintainer-only infrastructure.

Before substantive work, read the controlling Issue, this file, the relevant code/tests/docs, any current PR, and current CI/review state. Keep one coherent Issue/PR scope. Use synthetic, public, contributor-owned, or explicitly distributable fixtures only.

## Development workflow

For formal tracked work:

1. Use an independent branch/worktree from the intended current base.
2. Make the smallest maintainable, testable, reversible change that satisfies the Issue.
3. Run applicable deterministic checks: build, tests, type checks, lint/format, security/dependency checks, and public/repository sanitization gates.
4. Self-review the complete diff against the fresh intended base.
5. Complete the required Antigravity review on the exact final substantive commit **before opening the PR**.
6. Open a focused PR only after the pre-PR gate passes.
7. Let GitHub CI and Gemini review the exact submitted HEAD; address substantive findings and rerun affected validation.
8. Stop for final ChatGPT / Owner review and the Owner's explicit merge decision.

Do not create code churn for style-only, duplicate, false-positive, or technically inapplicable review comments. Record a concise evidence-based disposition instead.

## Required Antigravity gate

The Codex Cloud Environment exposes Antigravity through the standard command `agy`.

Before declaring the gate unavailable:

- run `command -v agy`;
- run `agy --version`;
- confirm the required model is available with the CLI's model-listing command.

Use **`gemini-4-argon-high`** unless the Owner explicitly changes the required model.

The review must cover the complete exact-final substantive diff in plan/sandbox/read-only mode with strict permissions:

- no file writes;
- no shell/command execution;
- no URL/network access;
- no MCP/tool expansion;
- no fallback model.

Do not save or commit raw review transcripts.

If `agy` or the required model is genuinely unavailable after the checks above, record the gate as **BLOCKED / NOT_RUN** and do not open the PR as though the gate passed. Do not substitute another reviewer.

A substantive change after Antigravity invalidates that review evidence; rerun the applicable deterministic checks and repeat the complete-diff Antigravity review on the new exact HEAD.

## GitHub CI and Gemini

After the PR is opened:

- wait for the configured GitHub CI/security checks;
- let the normal Gemini review run;
- verify whether Gemini has reviewed the current exact substantive HEAD before manually requesting another review;
- never request duplicate Gemini review for the same exact substantive HEAD;
- if a valid finding changes substantive behavior/security/privacy/persistence/compatibility, rerun affected tests and the required complete-diff Antigravity review, push the new HEAD, then obtain final exact-HEAD CI/Gemini evidence.

The final substantive HEAD must have complete required validation, Antigravity, CI, and Gemini evidence before merge review.

## PR handoff

Record in the PR:

- exact final HEAD SHA and intended base;
- focused and full validation results;
- Antigravity exact-HEAD result and model;
- GitHub CI result;
- Gemini exact-HEAD result and finding dispositions;
- known limitations and honest `NOT_RUN` checks;
- rollback or migration impact when relevant.

A passing review or CI result is not merge authority.

## Public safety and repository boundaries

Never commit credentials, cookies, secrets, private host/network identifiers, private repository content, student/participant records, grades, submissions, private course material, restricted research data, runtime databases/logs/backups, raw recordings, model weights without redistribution rights, or private operational evidence.

Preserve Local defaults, explicit optional provider selection, no silent fallback, bounded resource use, secure session/role boundaries, source provenance, cancellation/cleanup, and truthful limitations. Public feature claims must match executable behavior and validated evidence.

Do not introduce Enterprise/multi-user infrastructure, institutional SSO/LTI registration, tenant management, unrelated databases/services, or wider live access unless a separate controlling Issue and Owner decision explicitly select that work.

## Authority

Only the Owner may authorize merge, tag/release publication, deployment, live/institutional configuration changes, credential changes, or creation of Enterprise repositories. Merge and release/deployment are separate decisions.
