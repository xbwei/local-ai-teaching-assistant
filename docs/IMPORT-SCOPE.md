# Public import scope

LAITA Public V1 uses a bounded, one-way sanitized import. A file-level inventory was completed before importing; source Git objects, runtime and operational records were never imported. There is no automatic or bidirectional synchronization.

[Public destination inventory](import-files.json) classifies each delivered application, test, configuration and documentation file. The two inventory documents themselves are RECREATE. Exact source provenance and excluded private filenames remain local review evidence, outside this public repository.

- COPY: publicly suitable source and fixtures retained unchanged.
- GENERICIZE: accepted application behavior, contracts, tests and local lifecycle helpers retain functionality while namespaces, configuration identifiers, UI language and paths become LAITA/operator terminology. Full Local-only provisioning is supported without a Cloud mapping.
- RECREATE: public README/deployment/security/contribution/license-boundary documentation, synthetic course fixtures, examples of operator provisioning, public presentation documentation, original wordmark and public-boundary checks.
- EXCLUDE: private Git/history, operational deployment profiles and remote-host access/capture tools, obsolete scaffolds, private audit/handoff documents, runtime databases/history/logs/audio/backups, credentials and unapproved source screenshots. Upstream course blobs are replaced with authored synthetic fixtures; actual course Markdown is fetched read-only at runtime and keeps its own rights.

The original five Owner-authorized real image derivatives and the older demo video/GIF were separately reviewed as GENERICIZE presentation assets with metadata removal/cropping and a device-label redaction. Newer Owner-supplied **synthetic DEV workflow** GIFs and screenshots are distinct **post-import presentation candidates**, explicitly labeled with DEV provenance and subject to their own media/privacy review and exact-path public allowlist; they do not imply importing private source code, operational records or student data. [Full media manifest](SCREENSHOTS.md).

The online home-screen icons and phone captures are RECREATE. The icons render the existing LAITA wordmark. The browser captures use synthetic state only. [Media provenance](SCREENSHOTS.md)

The v0.3.0 Public release supports separate Admin/Teacher/Student practice credentials and course-scoped Teacher Chat/History tools. A signed Canvas Instructor launch and a **separate** operator-owned REST token enable bounded Teacher operations: teacher-selected Assignment Groups, unpublished Page/Assignment/Module creation, approved title-only edits, and dynamically refreshed saved Page/Assignment selection with explicit preview/confirmation for appending to an unpublished Module. LTI Learner launch maps to Student, not Teacher. The optional Canvas Chat plugin reads one configured Test Student's data for one approved assignment per request. Teacher feedback remains a separate confirmed write to the exact reviewed Test Student submission; GitHub/MongoDB verification remains bounded and read-only, with current-attempt previews. Local is the default, OpenAI/Compare is explicit, and source-grounded/refusal, local speech and owner History retain their documented limits. No actual school deployment or real Canvas integration acceptance is established by these synthetic tests.

Inventory classification is an import decision, not a claim that external content is MIT-licensed. See [third-party boundaries](../THIRD_PARTY.md).

The inventory also lists public-native files that predate the update. Their classification describes their public disposition and does not imply an external origin.

The initial import inventory recorded 113 COPY, 184 GENERICIZE and 52 RECREATE paths, plus the two inventory documents. Those were **initial-import classification counts**, not a claim that subsequent Public-native code, documentation and staged media PRs have never added files. Review current Git tree, the code/asset-specific checks and [release validation](VALIDATION.md) for current inventory and boundaries.
