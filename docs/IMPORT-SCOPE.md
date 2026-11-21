# Public import scope

LAITA Public V1 uses a bounded, one-way sanitized import. A file-level inventory was completed before importing; source Git objects, runtime and operational records were never imported. There is no automatic or bidirectional synchronization.

[Public destination inventory](import-files.json) classifies each delivered application, test, configuration and documentation file. The two inventory documents themselves are RECREATE. Exact source provenance and excluded private filenames remain local review evidence, outside this public repository.

- COPY: publicly suitable source and fixtures retained unchanged.
- GENERICIZE: accepted application behavior, contracts, tests and local lifecycle helpers retain functionality while namespaces, configuration identifiers, UI language and paths become LAITA/operator terminology. Full Local-only provisioning is supported without a Cloud mapping.
- RECREATE: public README/deployment/security/contribution/license-boundary documentation, synthetic course fixtures, examples of operator provisioning, public presentation documentation, original wordmark and public-boundary checks.
- EXCLUDE: private Git/history, operational deployment profiles and remote-host access/capture tools, obsolete scaffolds, private audit/handoff documents, runtime databases/history/logs/audio/backups, credentials and unapproved source screenshots. Upstream course blobs are replaced with authored synthetic fixtures; actual course Markdown is fetched read-only at runtime and keeps its own rights.

The five Owner-authorized real image derivatives and demo video/GIF are separately GENERICIZE presentation assets with metadata removal/cropping and a device-label redaction. They were not imported from a private source repository.

The online home-screen icons and phone captures are RECREATE. The icons render the existing LAITA wordmark. The browser captures use synthetic state only. [Media provenance](SCREENSHOTS.md)

The public Teacher tools provide Local course-grounded drafts, an opt-in History sample and signed Canvas Teacher authoring with a separate operator-owned REST credential. Teachers can create unpublished Pages and Assignments and rename approved Assignments. The accepted product retains Local default, both explicit Local models, optional OpenAI/Compare without fallback, multi-turn context, supported local bilingual speech, bounded public-course evidence/refusal and single-operator History & Review. Local service packaging and database-safe rollback remain generic operator tools; no real deployment was performed.

Inventory classification is an import decision, not a claim that external content is MIT-licensed. See [third-party boundaries](../THIRD_PARTY.md).

Delivered-file classification before these two inventory documents: 98 COPY, 161 GENERICIZE, 46 RECREATE.
