# Troubleshooting and GitHub Issues

LAITA is independently installed and operated. Your own host, model, HTTPS origin and optional Canvas permissions determine what works. Institution policies can prevent External App installation; LAITA cannot bypass them.

| Problem | First checks |
| --- | --- |
| Cannot sign in | Use the correct separate `admin`, `demo-teacher` or `demo-student` passphrase; check account status and whether a session was revoked. |
| Teacher/Student sees no course | Check the Admin's explicit active course grant and reauthenticate. |
| History count is zero | A new Demo Student must actually ask questions in that course first. Zero is not a defect without recorded questions. |
| Local generation fails | Start Ollama; check `ollama list`, the exact tag, memory and the one-operation BUSY limit. No silent provider fallback. |
| Canvas launch fails | Check LTI 1.1 course policy, signed course/user/role mapping, approved app credentials and trusted HTTPS. Student View is not proof of signed Learner launch. |
| Canvas authoring unavailable | Check signed Instructor session plus **separate** valid REST token/permissions for the same course and Teacher. |
| Assignment Group is missing | Refresh the same-course Group catalog; partial/unavailable catalog cannot be used as a stale choice. |
| Newly created Module/Page/Assignment cannot be selected | Enable `"modules": { "organizeSavedResources": true }` in the **one-time protected REST config**, then refresh saved resources; this mode does not need manual per-object ID edits. |
| Canvas result is uncertain | Inspect actual Canvas before attempting another write; a timeout may conceal a successful prior write. |
| Verification reports Unknown/Partial | Check current submission preview/attempt and permitted external provider, then refresh. |
| Phone cannot open LAITA | It must reach/trust its own operator HTTPS origin; `localhost` refers to the phone, not your computer. |

See [installation](GETTING-STARTED.md), [Canvas](CANVAS.md), [History](HISTORY.md), [verification](CANVAS-VERIFICATION.md) and [recovery](DEPLOYMENT.md).

## Report a bug safely

Open [GitHub Issues](https://github.com/xbwei/local-ai-teaching-assistant/issues/new). State **exact release tag or SHA**, OS/device, Node/npm/model tag where relevant, expected result, actual result, concise reproduction steps using synthetic data and whether you ran a local test, browser fixture or real authorized integration. Provide sanitized errors only.

**Never post:** Canvas consumer keys/shared secrets, REST bearer tokens, cookies, OAuth payloads, MongoDB connection strings/passwords, real student names/IDs/rosters/grades/submissions, private repos, hostnames, local runtime paths, database files or unredacted screenshots. Use `example.test` placeholders. Security/privacy concerns should follow [SECURITY.md](../SECURITY.md) instead of a public exploit report. Feature requests should describe a real instructor task and expected outcome.
