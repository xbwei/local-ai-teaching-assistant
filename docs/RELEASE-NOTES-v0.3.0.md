# LAITA v0.3.0 — Local Teaching Workflows and Optional Canvas Tools

LAITA is a local-first teaching assistant for an individual instructor or technical early adopter who manages their own installation. This update brings mobile access, Local drafting, scoped Canvas tools, practice verification and local support into the public app.

The [published releases](https://github.com/xbwei/local-ai-teaching-assistant/releases) page is the authority for available tags and release dates. These notes describe the v0.3.0 release track; documentation preparation does not itself publish a release.

## Highlights

| Workflow                        | What changes for the operator                                                                                                                                                                                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phone and home-screen entry     | Use the responsive interface from a phone that can reach the trusted LAITA HTTPS origin. Safari can add an online home-screen entry. A connection to the host is required.                                                                                                 |
| Course Chat                     | Ask questions against the supported public course mappings and inspect the displayed evidence. Local course grounding retains bounded retrieval and refusal when evidence is missing or insufficient.                                                                      |
| Local teaching drafts           | Generate a lesson or assignment draft from supported course material, inspect its sources and edit the Markdown before use.                                                                                                                                                |
| Canvas authoring                | In the signed Teacher session, preview and explicitly create an unpublished Page, Assignment or empty Module; rename an approved Assignment; or append one approved Page or Assignment to an approved unpublished Module.                                                  |
| Sample questions and feedback   | Use the standalone Teacher History plugin for one configured Test Student sample. The separate Canvas Chat panel answers Count/Score questions for its configured Test Student and assignment. Feedback requires a plain-text preview, explicit confirmation and readback. |
| GitHub and MongoDB verification | Check the current attempt for each configured practice student through bounded read-only metadata or aggregate operations. Inspect Observed, Partial, Unknown and unchecked results; these are not grades or authorship determinations.                                    |
| Admin support                   | Look up a retained turn's correlation reference for bounded, metadata-only diagnostics.                                                                                                                                                                                    |

The dependency baseline includes Marked 18.2.1 and rendering regressions for fenced code and literal HTML. No new SQLite migration is introduced by this update.

[Public workflow tour](DEMO.md) · [Getting started](GETTING-STARTED.md) · [Teacher tools](TEACHING-WORKFLOW.md) · [Canvas setup](CANVAS.md) · [Verification setup](CANVAS-VERIFICATION.md)

## Product and data boundaries

- **One Owner:** Admin, Teacher and Student are local role views for the same operator. This release does not provision independent student accounts, add campus SSO, or provide multi-user course membership administration.
- **Local-first:** inference, bounded course evidence and retained History use the operator's host. Optional OpenAI is an explicit choice for eligible general requests, with its own data flow; course excerpts and archived History are not sent to OpenAI.
- **Optional Canvas:** signed launch admits the configured Instructor into Teacher. Launch credentials and the optional backend REST token are distinct. The public app does not provide Canvas Student launch.
- **Controlled external actions:** preview is read-only. An explicit confirmation is followed by a target recheck, a write and independent readback. An uncertain or unverified result requires checking Canvas before any retry. No automatic grade update is provided.
- **Bounded observations:** GitHub verification reads configured metadata, not file bodies or executable submissions. MongoDB uses fixed read-only operations and does not display credentials, connection strings, collection/field names, document values or exact document counts in verification results.
- **Reference environment:** the supported setup is self-managed, with Apple Silicon macOS as the reference environment. Windows is not a supported host. Phone access requires a reachable trusted HTTPS origin; no offline inference or offline app cache is provided.

See [security](../SECURITY.md), [data flow](ARCHITECTURE.md) and [validation limits](VALIDATION.md).

## Upgrade from v0.2.0 and recovery

1. Stop active work and retain a protected, version-matched snapshot of the runtime database and the build that produced it.
2. Follow the documented [update and recovery procedure](DEPLOYMENT.md#explicit-update-and-recovery), then build and restart the selected version with your operator-owned configuration.
3. Check the initialized Owner credential, expected local History and the optional integrations that you actually configured.

The v0.2.0-to-v0.3.0 update retains SQLite **schema v5** and all five migration checksums. The integration validation reported that the synthetic upgrade and version-matched restore retained the Owner credential, History, feedback and accounting. Recovery restores the stopped snapshot with its matching build; do not edit migration rows or downgrade the database by hand. Records created after the restored snapshot will not be in that copy.

## Evidence and remaining acceptance

The [integration PR #93](https://github.com/xbwei/local-ai-teaching-assistant/pull/93) records validation on `33b11ae1b96483446dfc795b2371abe9fe765ffd`, merged into public main as `8d8bfc556899eeb1169ebf961d35ede72f2c002a`. Its results are release evidence, not a claim that this documentation pass repeated every check.

| Evidence                                           | Recorded result and limit                                                                                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Locked install, build and deterministic validation | Reported passing in the integration handoff, including runtime compatibility, public-boundary and security checks.                                                        |
| Synthetic browser integration                      | All 19 Chromium scenarios reported passing, covering Chat, Teacher tools, Canvas previews/readback, both verifiers, History, Admin and synthetic audio.                   |
| Upgrade and recovery                               | Synthetic v0.2.0 upgrade and version-matched restore retained the stated data and five checksums; a corrupt-checksum copy was rejected.                                   |
| Live providers and devices                         | Native Safari, physical devices, real inference/speech and live Canvas, GitHub practice repository and Atlas acceptance were **NOT_RUN** for that integration validation. |
| Visual examples                                    | The phone images are synthetic Chromium captures of the public UI. Workflow diagrams explain implemented behavior; they are not screenshots or live execution receipts.   |

Use the final release's resolved commit and applicable CI/review evidence when assessing a particular installation. Model accuracy, teaching effectiveness and time savings have not been established by these software checks.

## Media and project information

The public [workflow tour](DEMO.md) uses accurately labeled public captures and diagrams. Demonstrations from other development configurations may show broader interfaces or permissions; they are not evidence that those features ship in this public release. The [media provenance](SCREENSHOTS.md) distinguishes public synthetic images from historical demonstrations.

LAITA is an independent faculty-led open-source project, not an official James Madison University service or product. LAITA-authored software uses the [MIT License](../LICENSE); third-party models, course content, dependencies and media retain their own rights. [Project background and acknowledgments](ABOUT.md) · [Third-party boundaries](../THIRD_PARTY.md).
