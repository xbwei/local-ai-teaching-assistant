# LAITA v0.2.0 — Canvas Launch, Local Roles, and Course-Grounded AI

## Highlights

- **Individual / self-managed:** Public LAITA serves individual instructors and technical early adopters who manage their machine, models, runtime, Owner credential and optional integrations. Core standalone use needs no institutional server, central SSO or institution-wide provisioning.
- **Local-first architecture:** local inference, bounded public course evidence and retained text History run on the operator's host. Optional OpenAI is an explicit choice with a separate data flow, not a fallback.
- **Local Owner roles:** Admin / Teacher / Student views have scoped sessions and History. They are views for one Owner, not provisioned student or teacher accounts.
- **Optional Canvas course launch:** a signed course-level launch enters the existing local Teacher view for one configured Owner, course and Instructor identity.
- **Course-grounded Q&A:** supported public GitHub sources provide visible repository/commit/path/section provenance and excerpts. Unavailable, invalid or insufficient evidence fails closed before model invocation. Course evidence stays Local; OpenAI/Compare course requests are refused.
- **1 MiB per-course public snapshots:** the restored capacity accepts up to 32 allowed Markdown files, at most 192 KiB per file and 1,048,576 bytes total. Public-source support remains bounded to explicit course/repository mappings.
- **Explicit providers:** Local / optional OpenAI / Compare selection shows provider/model identity with no silent fallback. Optional OpenAI uses the operator's own server-side macOS Keychain credential.
- **History & Review:** review retained local questions, answers, sources, feedback and diagnostic state without invoking a model.
- **Optional local speech:** configured reference adapters support English/Chinese recognition and spoken replies within documented environment and browser limits.

## Canvas boundary

Canvas is optional; standalone LAITA does not require it. The current course-level External App uses Paste XML and operator-managed consumer key/shared secret launch credentials. These are neither Canvas passwords nor Canvas REST API tokens. **No Canvas REST API token is required.**

The operator supplies the Canvas HTTPS origin, numeric course ID, numeric Owner user ID, generated consumer key/shared secret and exact LAITA HTTPS origin. Installation depends on actual account permissions and institution policies. The integration does not ingest rosters, grades, submissions or Canvas course content, provision accounts, or provide institution-wide registration or LTI 1.3. See the canonical [Canvas setup, removal and troubleshooting guide](CANVAS.md).

Public GitHub course-source access is separate: read-only public APIs require no GitHub token, and standalone LAITA requires no GitHub account. Anonymous API limits may apply.

## Privacy and security

Use only non-sensitive operator-owned input. Local text History persists without automatic expiry or built-in encryption at rest; raw audio is temporary. Optional OpenAI sends only eligible general requests and bounded provider-specific active context, not course excerpts or archived History. Keep the reference API/HTTPS entry on loopback and protect the local account, runtime and external credential configuration. See [security policy](../SECURITY.md), [data flow](ARCHITECTURE.md) and [validation scope](VALIDATION.md). The Owner-provided README GIF is a sandbox demonstration with no real student or teacher data; [media provenance](SCREENSHOTS.md).

## Upgrade / rollback

Follow the existing [deployment update and recovery procedure](DEPLOYMENT.md#explicit-update-and-recovery); stop active work and preserve the appropriate database backup before migration. v0.2.0 uses the same SQLite store with additive **schema v5** for the Owner verifier, persistent launch nonces and role/context metadata. v1–v4 migration checksums remain unchanged. Existing History is retained and pre-v0.2 records are visible only to local Admin. Initialize the Owner credential against the same runtime before using local roles.

Older binaries refuse schema v5. Reverting application code alone is insufficient: use the documented rollback with a **pre-v5 backup**, preserving the newer database separately. Records and credentials created after that backup will be absent from the restored copy. Never remove migration rows or downgrade by hand. Disabling/removing Canvas preserves standalone credentials and History and requires no schema downgrade. Canvas configuration is documented for foreground API operation; automatic injection into the macOS LaunchAgent is not included. This documentation/media preparation itself adds no runtime or schema change.

## Limitations

- Model answer quality depends on model and environment; visible citations do not guarantee correctness. Retrieval/content quality is not universally solved. Lab 10 retrieval/content behavior is explicitly out of scope for this release task.
- Local model availability and performance depend on hardware and installed model assets. The reference environment is Apple Silicon macOS; credential/configuration checks require macOS/Linux POSIX ownership, and Windows is unsupported.
- Speech quality, audio hardware, language behavior and browser recording/playback policies vary; universal speech support is not established.
- Canvas account permissions and institution policies vary. Browser loopback/private-network, TLS, Origin and new-window behavior require checks in the operator's authorized environment; no policy bypass is provided.
- Public GitHub anonymous API limits and source availability may prevent refresh. Support remains limited to explicitly mapped public repositories and bounded Markdown evidence, not arbitrary repository import or Canvas content retrieval.
- LAITA remains single-operator with one admitted operation and no queue. It is not a hosted multi-user platform, roster integration, grading or submissions system. Automatic student accounts are not provided.
- A future Enterprise offering is a separate future product/repository direction and is not available in this release.

Deterministic synthetic tests and sandbox media do not establish real model, speech, hardware or every Canvas environment's acceptance. See [validation and limitations](VALIDATION.md).
