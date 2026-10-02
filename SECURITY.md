# Security policy

LAITA Public V1 is a single-operator application. Keep the reference HTTPS entry and API on loopback. A shared or remote entry requires an independently protected operator network boundary. The History dashboard has no additional password or user isolation.

Use only non-sensitive operator-owned input. Do not send student records, grades, submissions, credentials, private institutional material or sensitive research data. Safety filters are bounded heuristics, not a certification.

OpenAI is optional and explicit. On the macOS reference deployment, keys stay in the operator's Keychain and are consumed through a server-only one-use handle. Configuration contains opaque references and synthetic naming examples only. Do not put API keys in `.env`, JSON, Git, browser storage, SQLite, logs or screenshots.

Text, transcripts, answers, provenance, feedback and diagnostic state persist locally with no automatic expiry. Raw audio is temporary. New conversation resets context but does not delete history. Use disk/account protection; built-in encryption at rest and a separate dashboard password are not provided.

Report vulnerabilities privately using GitHub's private vulnerability reporting when available on this repository. If unavailable, contact the maintainer using the contact route on the [public faculty profile](https://www.jmu.edu/cise/people/faculty/wei-xuebin.shtml), first sending only a high-level description and asking for a secure reporting channel. Do not post exploit secrets or private data in public Issues. No response-time guarantee is made.

See [validation and limitations](docs/VALIDATION.md) for LAITA Public V1's validation scope. The public repository has CodeQL default setup, hosted secret scanning and push protection enabled. These checks are not a security certification or deployment acceptance. No paid security service is required.
