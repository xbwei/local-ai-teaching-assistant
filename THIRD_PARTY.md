# Third-party and licensing boundaries

The MIT license covers LAITA-authored source, documentation, wordmark and synthetic fixtures. It does not grant rights to external software, models, course content, datasets, voices or institutional marks.

## Software

The locked npm dependency graph is in `package-lock.json` and `policy-contracts/package-lock.json`. Direct runtime/build dependencies include Express (MIT), OpenAI JavaScript SDK (Apache-2.0), Ajv (MIT), Marked (MIT), TypeScript (Apache-2.0), Vite (MIT), Prettier (MIT) and Node type definitions (MIT). Transitive dependencies retain their packaged license notices; inspect them when redistributing a packaged build.

Node.js, SQLite, Ollama, whisper.cpp, Caddy, Semgrep CE, TruffleHog, actionlint and optional developer tooling are independently licensed projects. They are installed separately rather than relicensed here. See [Node licenses](https://github.com/nodejs/node/blob/main/LICENSE), [SQLite copyright](https://www.sqlite.org/copyright.html), [Ollama license](https://github.com/ollama/ollama/blob/main/LICENSE), [whisper.cpp license](https://github.com/ggml-org/whisper.cpp/blob/master/LICENSE), [Caddy license](https://github.com/caddyserver/caddy/blob/master/LICENSE), [Semgrep licensing](https://github.com/semgrep/semgrep/blob/develop/LICENSE), [TruffleHog license](https://github.com/trufflesecurity/trufflehog/blob/main/LICENSE) and [actionlint license](https://github.com/rhysd/actionlint/blob/main/LICENSE.txt). macOS voices and Keychain are supplied by Apple under Apple's terms.

## Models and Cloud

No model weights are bundled. Check [Gemma terms](https://ai.google.dev/gemma/terms) before downloading/using Gemma and the [Llama 3.1 license](https://www.llama.com/llama3_1/license/) and acceptable use requirements before using Llama. Whisper Small Multilingual weights have their own upstream model terms; consult [OpenAI Whisper](https://github.com/openai/whisper). OpenAI API usage requires your own account and applicable service terms. Model availability, pricing and permissions can change; embedded policy pricing is an admission-control estimate, not a current price guarantee.

## Course content, datasets and marks

IA340 and IA342 are read-only references to public repositories. LAITA neither bundles those repositories wholesale nor claims that its MIT license covers their text, linked datasets, tools or images. Public accessibility does not imply unrestricted redistribution. Preserve exact citation identity and inspect the source's own license/permissions for other reuse.

Automated fixtures are newly authored synthetic material and are not statements of actual course requirements. The five real screenshots/photos and real demo video/GIF are included with explicit Owner authorization and reviewed privacy edits, as recorded in [media provenance](docs/SCREENSHOTS.md). They contain incidental product marks and public course wording; the software MIT license does not relicense those underlying marks/content. The LAITA wordmark is original and uses no institutional or third-party logo. References and acknowledgments do not imply endorsement.
