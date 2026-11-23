<p align="center"><img src="apps/web/src/laita.svg" width="72" alt="LAITA" /></p>

# LAITA — Local AI Teaching Assistant

**Local-first AI for course-grounded questions and instructor-controlled teaching workflows.** LAITA is independent, self-managed faculty-led software—not an official JMU service.

[![DOI](https://zenodo.org/badge/1400722177.svg)](https://doi.org/10.5281/zenodo.24452009)

**Latest release:** [LAITA v0.3.0](https://github.com/xbwei/local-ai-teaching-assistant/releases/tag/v0.3.0) (November 22, 2026). [Versioned source](https://github.com/xbwei/local-ai-teaching-assistant/tree/v0.3.0) · [Release notes](docs/RELEASE-NOTES-v0.3.0.md) · [v0.3.0 software DOI](https://doi.org/10.5281/zenodo.24452010).

**Technical report:** [LAITA v0.3.0: Local AI Teaching Assistant — Illustrated Technical Report](https://doi.org/10.5281/zenodo.24454348) (Wei, 2026). This report has its **own DOI**, distinct from the archived v0.3.0 software DOI above.

LAITA runs on a machine and local model **you** manage. Standalone use needs no Canvas, GitHub practice token, MongoDB account or OpenAI key. Optional integrations are enabled separately and must use only your own authorized, non-sensitive data. No central school servers or SSO are provided.

## Watch the workflows — recent development previews

**Full development walkthrough:** [Watch the complete LAITA v0.3.0 demo on YouTube](https://youtu.be/C6K6ukVqtu4) (unlisted). This Owner-supplied recording illustrates the synthetic DEV workflows; it is not a pixel-identical walkthrough or live-service acceptance test of the tagged Public release.

These Owner-supplied **development previews use sandbox/demo data**. They illustrate the teaching journeys behind the v0.3.0 release, **not pixel-identical captures or live acceptance of the current Public build**. Public permissions and some UI steps differ; the [six step-by-step Public workflows](docs/DEMO.md) describe the actual supported product.

| **Teacher Generate** — AI-assisted content | **Student in Canvas** — ask and follow up | **Teacher Verify** — inspect practice work |
| :---: | :---: | :---: |
| <img src="docs/assets/demo/v030-dev/04-Teacher-Generate-excerpt.gif" width="230" alt="Synthetic DEV preview: Teacher generates and reviews assignment and page drafts" /> | <img src="docs/assets/demo/v030-dev/02-Student-in-Canvas.gif" width="230" alt="Synthetic DEV preview: Student asks course questions through Canvas" /> | <img src="docs/assets/demo/v030-dev/05-Teacher-Verify.gif" width="230" alt="Synthetic DEV preview: Teacher verifies configured practice submissions" /> |
| *Editable drafts, human review, Canvas creation* | *Course-grounded answers and History* | *Read-only GitHub/MongoDB checks, separate feedback* |

| **Teacher Chat** — scoped tools | **Mobile experience** — online PWA | **Roles** — local practice accounts |
| :---: | :---: | :---: |
| <img src="docs/assets/demo/v030-dev/03-Teacher-Chat.gif" width="230" alt="Synthetic DEV preview: Teacher selects Canvas and History chat tools" /> | <img src="docs/assets/demo/v030-dev/06-Mobile-PWA-excerpt.gif" width="230" alt="Synthetic DEV phone preview: Open the LAITA web app and browse Teacher tools" /> | <img src="docs/assets/demo/v030-dev/01-Website-Roles.gif" width="230" alt="Synthetic DEV preview: Admin, Teacher and Student role views" /> |
| *General, Canvas and History* | *A browser connection to your own host is required* | *DEV Admin includes controls not shipped in the single-Owner Public Admin* |

**New source screenshots from the same sandbox** (select an image to inspect full size):

| AI-assisted Assignment draft | Saved Page + Assignment in Module | MongoDB practice observations |
| :---: | :---: | :---: |
| [<img src="docs/assets/screenshots/v030-dev/04d-Generated-assignment-suggestion.png" width="285" alt="Synthetic DEV screenshot: editable AI-generated assignment draft" />](docs/assets/screenshots/v030-dev/04d-Generated-assignment-suggestion.png) | [<img src="docs/assets/screenshots/v030-dev/04k-Canvas-module-with-ordered-items.png" width="285" alt="Synthetic DEV screenshot: Canvas Module with saved Page and Assignment" />](docs/assets/screenshots/v030-dev/04k-Canvas-module-with-ordered-items.png) | [<img src="docs/assets/screenshots/v030-dev/05e-MongoDB-count-and-sampled-fields.png" width="285" alt="Synthetic DEV screenshot: bounded MongoDB verification observations" />](docs/assets/screenshots/v030-dev/05e-MongoDB-count-and-sampled-fields.png) |

All animations are labeled *Development Preview*. The Generate and Mobile files above are **short excerpts** of the original Owner-supplied recordings; the originals remain unchanged. The DEV captures were published with disclosed provenance and bounded visual inspection; full-frame privacy certification and exact-Public-image parity are not claimed. [Media details and caveats](docs/SCREENSHOTS.md).

## Start here

| I want to… | Read |
| --- | --- |
| Install Node, Ollama, the reference HTTPS edge, and launch LAITA | [Getting Started](docs/GETTING-STARTED.md) |
| Initialize Admin / Demo Teacher / Demo Student and assign courses | [Accounts and course grants](docs/GETTING-STARTED.md#initialize-accounts-and-course-access) |
| Connect an authorized Canvas course using External App / Paste XML | [Canvas configuration](docs/CANVAS.md) |
| Generate teaching content and create a Page, Assignment or Module | [Teacher workflows](docs/TEACHING-WORKFLOW.md) |
| Verify practice submissions with bounded read-only GitHub/MongoDB checks | [Assignment verification](docs/CANVAS-VERIFICATION.md) |
| Reproduce the six teaching scenarios | [Workflow guide](docs/DEMO.md) |
| Check setup errors or file a safe GitHub Issue | [Troubleshooting and support](docs/SUPPORT.md) |
| Review the released version's tests and limitations | [Validation](docs/VALIDATION.md) |

## Public v0.3.0 capabilities

- **Local and grounded Chat.** Explicitly select installed Ollama models, ask follow-ups and inspect bounded public course-source evidence. Missing/ambiguous evidence is not silently fabricated. Optional OpenAI/Compare requires your own API access, explicit selection and charges.
- **Scoped practice roles.** One Admin/Owner plus *separately authenticated* Demo Teacher and Demo Student accounts. Admin manages account labels/status, sessions and IA340/IA342 course grants. An installed copy is **single-operator**; these are not real enrolled users.
- **Teacher Chat and History.** General chat, permitted Canvas tools and scoped Demo Student History Count/Summary can be selected in the same authorized course context. A fresh install starts with zero questions.
- **Editable AI teaching drafts.** Teacher Generate uses supported public course sources, exposes the source details and produces text the Teacher can edit. Model-generated drafts do not write to Canvas.
- **Optional Canvas LTI + authoring.** An appropriately mapped, signed **Instructor or Learner** course-level LTI 1.1 launch uses its own launch credentials; Canvas **REST writes require a separate Instructor token**. A Teacher can refresh and choose the destination Assignment Group; preview/confirm/create an *Unpublished* Page, Assignment or Module; refresh already saved Pages/Assignments/Modules, choose and order resources and append them to an **Unpublished** Module. A single opt-in REST setting enables this dynamic workflow without copying newly created object IDs into JSON. Teachers later publish in Canvas itself.
- **Read-only practice verification and optional feedback.** Current Canvas submission versions are previewed before selected/batch GitHub/MongoDB checks. Bounded observations are not grades or proof of authorship. Posting Test Student feedback is a separate explicit confirm/readback action.
- **Mobile web/PWA.** Responsive browser with online Safari home-screen option when your phone can reach and trust the self-managed HTTPS origin. The supplied loopback-only reference is **not** a remote-host deployment.

## Limitations, privacy and support

The reference setup is Apple Silicon macOS, Node 24/npm 11, Ollama, an operator-owned loopback HTTPS entry and locally stored SQLite. Course grounding uses explicitly supported public IA340/IA342 mappings, not arbitrary RAG, private course repos or institutional LMS data. Optional Canvas, Github/MongoDB and OpenAI connections need the appropriate rights and may be unavailable under your organization’s policies. Keep all Canvas secrets, student-related records and practice URIs out of public bug reports. Protect your own host and backup; retained text History has no automatic purge.

This source release has not been accepted on physical devices or against arbitrary real Canvas, Atlas, GitHub or school installations. See [validation](docs/VALIDATION.md) and [security](SECURITY.md).

## Author and community

Created and maintained by **Xuebin Wei, Ph.D.**, Associate Professor at James Madison University. [Project background](docs/ABOUT.md). LAITA software is [MIT licensed](LICENSE); media, datasets, dependencies and model weights retain their respective terms in [THIRD_PARTY.md](THIRD_PARTY.md).

Report reproducible, **redacted** bugs via [GitHub Issues](https://github.com/xbwei/local-ai-teaching-assistant/issues/new), not by submitting tokens, MongoDB URIs, student PII or private Canvas content. [Support checklist](docs/SUPPORT.md).
