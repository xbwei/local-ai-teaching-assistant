# Contributing

Welcome! Open a focused [Issue](https://github.com/xbwei/local-ai-teaching-assistant/issues) with a synthetic reproduction or a concrete feature outcome before substantive work. Use an issue branch and one coherent pull request. Do not submit private/student data, secrets, real history/logs/audio, private Git artifacts or unrelated architecture.

Install the pinned Node/npm toolchain and Caddy 2.11.6 for reference-edge integration tests, then `npm ci --ignore-scripts` and `npm run build`. Developer tooling uses Python 3.12.14 and uv 0.12.7; `uv sync --project python --locked`. Run `npm run validate` for the full deterministic and policy gates. See [validation](docs/VALIDATION.md).

Preserve Local defaults, explicit provider/model selection, no silent fallback, multi-turn context, fail-closed Local grounding and the single-operator boundary. Add tests for substantive behavior and use synthetic fixtures. Never make a test pass by bypassing protections or hiding failures. Keep docs consistent with executable behavior.

Submit a focused change with a complete diff self-review, relevant tests and validation evidence. CI and security checks must pass on the final revision. Substantive changes require maintainer review and approval before merge. Publication and deployment remain separate maintainer decisions.

The MIT license covers contributed LAITA software. Retain third-party notices and do not bundle external course/model/dataset material without rights. No public/private repository synchronization is supported.

Dependabot runs scheduled version-update checks. Its pull requests are advisory and need normal review and maintainer approval; auto-merge is not enabled.
