# LAITA module boundaries

Eleven npm workspaces implement one single-operator application. Python is developer tooling only.

## Target directory and ownership map

| Logical module | Path | Owns | Must not own |
|---|---|---|---|
| `shared-contracts` | `packages/contracts/` | Versioned DTOs, interfaces, events, errors, identifiers, provenance, deterministic-evidence shapes | Business policy, storage, provider SDKs |
| `runtime-foundation` | `packages/runtime/` | Validated config, feature flags, secret-reference resolution, typed errors, redacted logging, limits/cancellation primitives | Client secrets, workflow decisions, deployment-specific values |
| `api-server` | `apps/api/` | HTTP routes, auth boundaries, request validation/limits, composition root, health/readiness presentation | Teaching policy, provider SDK behavior, SQL/Cypher |
| `web-portal` | `apps/web/` | Owner browser UI, accessibility, browser API client, client-visible state | Credentials, direct provider/database calls, authoritative policy |
| `chat-orchestration` | `packages/orchestration/` | Ordered dependency calls, streaming coordination, immutable provenance assembly | Policy decisions, retrieval queries, provider fallback, direct database access |
| `course-grounding` | `packages/course-grounding/` | Fixed public-course refresh, snapshot validation and bounded deterministic text retrieval | Arbitrary repositories/paths, execution, provider calls, crawler/database/daemon behavior |
| `provider-adapters` | `packages/providers/` | Provider-neutral interface, Ollama/OpenAI adapters, exact model/provider provenance | Eligibility, retrieval, persistence, safety authority, fallback |
| `policy-capability` | `packages/policy/` | Fail-closed capability/eligibility decisions, schedules, budgets, disable controls | Provider invocation, student-facing policy invention |
| `interaction-store` | `packages/persistence/` | SQLite migrations/repositories, transactions, retention/deletion, local operational state | Neo4j knowledge, identity profiles, official grades |
| `safety-boundary` | `packages/safety/` | Sensitive-value, prompt-injection, assessment, output, and abuse/resource decisions | Disciplinary profiles, provider-only safety delegation |
| `speech-media` | `packages/speech-client/` | Bounded STT/TTS adapters and temporary-media lifecycle | Permanent audio, LLM/provider routing, kiosk-only backend |
| `operations-runtime` | `ops/` and `.github/` | CI, generic deployment/service templates, inventory, backup/rollback, environment adapters | Application business logic, real deployment identifiers/secrets |

## Dependency rules

Imports must follow this acyclic graph. Browser code uses only the narrow
browser contracts entry; server secrets and Node builtins are prohibited.

| Module | May depend on |
|---|---|
| `shared-contracts` | — |
| `runtime-foundation` | `shared-contracts` |
| `policy-capability` | `shared-contracts`, `runtime-foundation` |
| `interaction-store` | `shared-contracts`, `runtime-foundation` |
| `provider-adapters` | `shared-contracts`, `runtime-foundation` |
| `safety-boundary` | `shared-contracts`, `runtime-foundation` |
| `speech-media` | `shared-contracts`, `runtime-foundation` |
| `chat-orchestration` | `shared-contracts`, `runtime-foundation`, `policy-capability`, `interaction-store`, `provider-adapters`, `safety-boundary` |
| `course-grounding` | `shared-contracts`, `runtime-foundation` |
| `api-server` | `shared-contracts`, `runtime-foundation`, `policy-capability`, `interaction-store`, `provider-adapters`, `safety-boundary`, `speech-media`, `chat-orchestration`, `course-grounding` |
| `web-portal` | `shared-contracts` |
| `operations-runtime` | `shared-contracts` |
