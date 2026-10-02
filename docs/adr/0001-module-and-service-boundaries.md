# Module boundaries

LAITA runs one API serving a browser UI. Contracts remain browser compatible; providers own network calls; persistence owns the existing SQLite store; speech owns temporary audio. Grounding supplies bounded public-source evidence only to Local. The module graph is checked in CI. See [module map](../MODULES.md).
