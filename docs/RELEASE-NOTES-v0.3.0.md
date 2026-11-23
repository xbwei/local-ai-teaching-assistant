# LAITA v0.3.0 — release notes

**Published November 22, 2026.** [GitHub release v0.3.0](https://github.com/xbwei/local-ai-teaching-assistant/releases/tag/v0.3.0) resolves to source commit `ed4b9c221ea2ebcc01c8ce1db32a35a69ccfb4a8`. [Archived software DOI for v0.3.0](https://doi.org/10.5281/zenodo.24452010) · [Software version-series DOI](https://doi.org/10.5281/zenodo.24452009).

## New in v0.3.0

- Separate local Admin/Owner and provisioned Demo Teacher/Student credentials; explicit supported-course grants, switching, account controls and scoped History. Not a self-service or institutional multi-user platform.
- Bound signed Canvas Instructor **and Learner** LTI 1.1 launch for mapped practice roles; no REST rights arise from the launch itself.
- General/Canvas/History Teacher Chat paths, current-course Demo Student Count/Summary, and editable source-grounded Local drafts available to authorized signed Canvas Teachers.
- Teacher-driven Canvas authoring with Preview → Confirm → Readback: **refresh actual Assignment Groups and choose one**, create Unpublished Page/Assignment/Module, then refresh saved Pages/Assignments/Modules and append chosen items in a reviewed order. Enable `"modules": { "organizeSavedResources": true }` **once** in the protected REST configuration; no per-object ID list editing is needed. The destination Module stays Unpublished; existing source resources may be Published or Unpublished.
- Current-submission-version preview required before bounded read-only selected/batch GitHub/MongoDB practice checks. Explicit Test Student feedback remains a distinct action.
- Responsive phone-size browser and PWA/home-screen path (online service required).

## Upgrade and rollback

Follow [Getting Started](GETTING-STARTED.md) for Node/npm/model/setup and [Canvas](CANVAS.md) for separate LTI/REST configuration. The released v0.3.0 version applies SQLite identity/course/account migrations **v6–v8** to a v0.2.0 **schema-v5** database. **Stop the service and take a version-matched full runtime backup** before upgrading. A rollback to v0.2.0 needs that **pre-upgrade v5 snapshot** and matching code/configuration; an older v0.2.0 binary cannot read the migrated v8 database. When returning to older Canvas code, restore its static `assignments.groupId` and `modules` configuration as applicable. See [deployment/recovery](DEPLOYMENT.md).

## Known limits and approved deferrals

- **Unpublished is the default and only supported creation state** for Pages, Assignments and Modules. Teacher publication happens directly in Canvas after review. The dynamic Module organizer can select Published source resources but only an Unpublished destination Module.
- Single-Owner Public Admin does not implement DEV's delegated Admin, variable Teacher/Student roles per course, whole-course enable/disable or per-person audited History investigation. Persistent support-number lookup for a failed History Summary is deferred; existing History and retained-turn diagnostics remain.
- **Canvas title overlap:** lookup by overlapping assignment titles may bind the wrong target. The Owner has accepted this *specific* known limitation for v0.3.0 only, with DEV-first fix planned in a later release. Avoid ambiguous titles; any broader authorization/privacy defect remains a blocker.
- No automatic grading, LTI 1.3, central SSO, unrestricted GitHub/RAG ingestion, institution-wide enrolment or live student use is provided. Optional integrations depend on the adopter’s actual permissions.

## Evidence and NOT_RUN

The #114 implementation record reports **736 Node tests**, a clean isolated install/reference HTTPS, synthetic upgrade and version-matched restore, and **24 synthetic Chromium scenarios**. Exact-head CRITICAL Antigravity, Gemini and independent DOT reviews are recorded for #113/#114. The merged main commit's **9/9 GitHub checks passed**. These records do **not** mean production/real-environment acceptance.

**NOT_RUN:** current Public live Canvas, real GitHub/MongoDB practice providers, physical iPhone/Android, native Safari/PWA, real model/voice quality and measured learning outcomes. DEV recordings apply to their recorded build, not this exact Public SHA. See [validation](VALIDATION.md) and [media](SCREENSHOTS.md).

[README](../README.md) · [Six workflows](DEMO.md) · [Help and safe GitHub Issues](SUPPORT.md). The v0.3.0 source release is published. Deployment, real-environment acceptance and future releases require separate Owner decisions.
