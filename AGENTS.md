# Agent Instructions — LAITA Public

## Scope

This is a public repository. Keep all work public-safe, repository-focused, and limited to the controlling Issue. A bounded Issue batch may select successive controlling Issues only under explicit Owner authorization recorded in Issues and the bounded batch rules below; it does not combine their scopes.

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
8. Obtain final ChatGPT / Owner review and the Owner's explicit merge decision, except where an applicable Owner-approved bounded batch explicitly delegates routine final merge-readiness assessment to DOT and conditional merge execution. Without that delegation, stop for individual Owner merge approval.

Do not create churn for duplicate, false-positive, style-only, or technically inapplicable review comments. Record a concise evidence-based disposition instead.

## Bounded Issue batches

Only an Owner-authorized and ChatGPT-profiled finite batch record in Issues may authorize this loop: selected Issue and assigned profile (missing, pending or ambiguous profiles block the loop) -> DOT dispatch/follow-up -> Codex implementation, validation, self-review, final-diff risk check and required Antigravity -> focused PR, CI, exact-HEAD Gemini and findings disposition -> DOT independent complete-diff review -> conditionally delegated merge -> next already-authorized Issue -> stop at the recorded boundary. Durable rules belong here; batch selection, authority and status remain in Issues. A roadmap, task launch, handoff or passing CI is not batch or merge permission.

- The batch record must identify this repository, ordered Issues, each Issue's scope/exclusions and assigned profile, the Owner's explicit conditional merge delegation (if any), and the stop boundary. ChatGPT retains profile assignment and material architecture/risk-escalation decisions. DOT coordinates dispatch/follow-up and independently reads the actual complete diff, tests, review evidence and findings dispositions; Codex remains the implementation agent and selects a qualified model/effort within the assigned profile. Codex self-review is not DOT's independent review or approval.
- Keep one traceable engineering task and one coherent Issue/PR scope per selected Issue, reusing valid handoffs. Ordinary in-scope debugging remains Codex's responsibility. Verify unknown task delivery or write effects before retrying; if the effect remains unknown, stop rather than risk duplicate execution.
- Before starting each next selected Issue, re-read GitHub for its current authority, scope, relevant PR/base/HEAD, checks, reviews and dependency state. Continue only while that Issue remains within the approved batch and all required gates and prior outcomes are established; do not infer permission for an unselected successor.
- Within an applicable Owner conditional delegation, DOT may make the routine final merge-readiness assessment without repeated manual relay. Before a merge, the authorized executor verifies the exact final HEAD, current required checks/reviews, resolved substantive findings and branch protections, then reads back the actual result. Do not bypass protections or enable unconditional auto-merge. Without applicable delegation, retain individual Owner merge approval. Merge alone does not authorize Issue closure, destructive cleanup, release, deployment or live acceptance.
- Stop for unresolved required gates, `RISK_ESCALATION_REQUIRED`, scope/architecture/security/permission/credential/cost changes, unknown effects, batch completion, the recorded stop boundary, or release/deployment/live acceptance. Report the evidence and required decision; do not broaden authority or spend unapproved quota to continue. No scheduler, orchestrator service, database or agent platform is introduced by this workflow.

Keep a concise English engineering handoff for each Issue: authority, exact base/HEAD, validation and review evidence, findings/dispositions, DOT's independent conclusion (or explicitly pending), actual execution/result and next action. If Codex posts a DOT conclusion, attribute its source and the executor accurately; DOT must read it back. Task submission alone does not prove completion or unattended continuation.

## Governance authorship and explicit exceptions

The Owner and ChatGPT author substantive changes to `AGENTS.md` and review policy through separate governance branches/PRs. Codex may faithfully edit an explicitly approved governance contract and provide evidence or execute validation/review as the implementation agent, but must not invent policy or decide or amend its own governing policy to unblock work. Reviewer models review independently; they do not replace Codex as the routine implementation agent.

Governance changes follow the currently effective main policy, not their proposed rules. Only an explicit Owner decision recorded in the controlling Issue/PR may waive a named gate for a defined scope. Record an Antigravity waiver as `NOT_RUN / OWNER_AUTHORIZED_EXCEPTION`, with its authority and scope, never as PASS or `SKIPPED_BY_POLICY`. Authorship alone grants no exemption. A waiver does not transfer to other PRs or in-flight work; applicable validation, public-boundary checks, CI, exact-HEAD Gemini and the Owner's separate merge decision remain required.

## Risk-based Antigravity review policy

**ChatGPT assigns the provisional review profile in the controlling Issue or explicit Owner-approved handoff. Codex develops the change, inspects the complete final substantive diff, selects a qualified actual model/effort within that profile, and executes review.** Codex reports `RISK_ESCALATION_REQUIRED` with exact affected code, concrete impact and available models if the final diff exceeds the profile. ChatGPT adjudicates; Codex cannot downgrade or waive its assigned profile. Missing or ambiguous profiles block the review/PR gate.

Choose by actual authority changes, consequences, reversibility and uncertainty, not a file name, security keyword or line count alone. A small session-lifetime change still changes credential authority; a cosmetic label does not. These routes allocate review effort, not guarantees that a model finds every bug.

**`NO_ANTIGRAVITY` is a separate skip state, not one of the four reviewed profiles.** It requires an explicit ChatGPT assignment for genuinely non-behavioral documentation/copy/cosmetic work with no runtime, security, privacy, data-contract or acceptance change. Preserve applicable validation, CI, public-boundary checks and Gemini. Record `SKIPPED_BY_POLICY`, never an Antigravity PASS.

### Four reviewed profiles

- **`STANDARD_ANTIGRAVITY`**: Ordinary bounded features, routine bugs, UI behavior and read-only logic without material authority or sensitive-state changes. Default: **Gemini 4 Hydrogen Medium**, effort **medium**.
- **`ELEVATED_ANTIGRAVITY`**: Difficult but bounded non-authority-changing logic, parsing, validation or state handling needing more scrutiny than `STANDARD_ANTIGRAVITY`. Default: **Gemini 4 Hydrogen High**, effort **high**. Localized permission checks or concurrency work fit here only if they do not change authority, isolation or material resource/recovery guarantees. Those changes remain `HIGH_ASSURANCE_ANTIGRAVITY` or above; `ELEVATED_ANTIGRAVITY` is not a quota-driven way around high-risk triggers.
- **`HIGH_ASSURANCE_ANTIGRAVITY`**: Material authentication/session/credential semantics, Canvas course identity, student/participant privacy or isolation, authorization, durable production state/transactions/migration, external writes, deployment/security boundaries, substantive review-policy/tooling changes, or consequential concurrency, cancellation, resource-limit and recovery changes. Default: **Gemini 4 Argon Medium**, effort **medium**. A bounded session-lifetime change belongs here; `HIGH_ASSURANCE_ANTIGRAVITY` does not automatically require Argon High.
- **`CRITICAL_ANTIGRAVITY`**: New or substantially redesigned authentication or authorization, major credential/privacy/security architecture, high-impact destructive migration/recovery, or broad review-gate redesign where failure has unusually large consequences or is difficult to contain or reverse. Default: **Gemini 4 Argon High**, effort **high**. Not every governance edit or production-related file automatically belongs here; justify the actual risk.

Codex verifies the installed model ID/effort and uses the assigned route or a permitted qualified fallback; it does not silently change profiles. Existing `NO_ANTIGRAVITY`, `STANDARD_ANTIGRAVITY`, and `HIGH_ASSURANCE_ANTIGRAVITY` identifiers remain valid. Do not retroactively invalidate historical evidence or reclassify in-flight work because new profiles exist.

### Qualified fallback

- After verified Hydrogen quota exhaustion, `STANDARD_ANTIGRAVITY` may use restricted-protocol-qualified **Gemini 3.8 Flash Medium**, or **Claude Sonnet 5.5 Medium** within an approved third-party quota budget. Do not automatically consume that budget.
- After verified Argon quota exhaustion, `HIGH_ASSURANCE_ANTIGRAVITY` may use qualified **Claude Opus 5.5 Medium/High** or **Claude Sonnet 5.5 High** within the approved budget. Hydrogen and Flash do not substitute for `HIGH_ASSURANCE_ANTIGRAVITY` or `CRITICAL_ANTIGRAVITY`.
- `ELEVATED_ANTIGRAVITY` and `CRITICAL_ANTIGRAVITY` alternatives require an explicit task-specific ChatGPT/Owner-approved route before invocation; do not infer them from another profile's whitelist. Opus and Sonnet share third-party quota. If no permitted qualified reviewer is available, record `BLOCKED / NOT_RUN`; no paid overages.

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
- for a bounded batch, its authority, DOT's independent conclusion (or pending status), actual execution/result and next action, with accurate source/executor attribution;
- rollback or migration impact when relevant.

A passing review or CI result is not merge authority.

## Public repository boundaries

Use only synthetic, public, contributor-owned, or explicitly distributable fixtures. Do not hard-code machine-specific paths, authentication state, secrets, private host/network identifiers, or deployment-only details.

Keep public claims consistent with executable behavior and validated evidence. Do not introduce unrelated infrastructure, live access, or broader product scope without a separate controlling Issue and Owner decision.

## Authority

Only the Owner may authorize merge, including explicit conditional merge delegation within a bounded batch, tag/release publication, deployment, live/institutional configuration changes, or credential changes. Delegated routine merge-readiness assessment does not authorize policy changes, release, deployment or live acceptance. Merge, release, and deployment are separate decisions. Proposed governance rules apply only after Owner-authorized merge; a governance PR cannot use its proposed batch loop or delegation to merge itself.
