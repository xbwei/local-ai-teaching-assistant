# Public course grounding

V1 recognizes IA340 and IA342 and their explicit public `JMU-Data` repositories. Run `npm run course-sources:refresh -- /absolute/operator/runtime` to refresh both. The runtime must be outside every Git checkout, canonical and protected. Refresh uses only unauthenticated public GitHub APIs, verifies public repository identity, resolves `main` to a commit, bounds file counts/sizes and reads allowed Markdown. It never follows arbitrary source links or fetches private repository credentials.

The bounded snapshot is local. A query-triggered freshness check runs after 24 hours. A manifest/source/hash validation or network failure is visible and does not grant permission to answer from remembered course facts. Each displayed citation has the actual repository, commit, path, section and supporting excerpt. Prepared request evidence is bounded and supplied only to Local. OpenAI/Compare course requests are refused before sending excerpts.

Query-triggered Local course preparation has one server-side 30-second deadline
starting before grounding, covering freshness checks, refresh and retrieval.
It is separate from the later provider timeout and never resets between GitHub
reads. Deadline or input cancellation propagates to GET requests and actively
cancels response body readers. The server awaits preparation settlement,
including reader cancellation and staging cleanup, before releasing the shared
admission slot. No provider is called after timeout/cancellation; History and
trace report `TIMEOUT` or `CANCELLED`, with `PROVIDER/NOT_EXECUTED`. Existing
snapshot files/pointers remain intact, cancelled work cannot promote a snapshot
or mark freshness successful, and the request fails closed. Closing a browser
or stopping client observation does not reset the server job or disable this
deadline. Other generation requests receive `BUSY` while cleanup is pending;
independent requests can run after cleanup settles. The deadline starts
cancellation at 30 seconds; terminal publication/admission release waits for
cleanup rather than abandoning work. Ordinary chat and explicit source
maintenance retain their existing behavior.

Retrieval is lexical and intent-aware, not an embedding/vector database. Whole-course overview intent prefers overview evidence; Lab/Week identifiers remain exact. Narrow transcript aliases may recover supported course identifiers without changing retained transcript text. Requests spanning both courses, unsupported specific claims, missing snapshots and insufficient evidence fail closed before provider invocation. A grounded answer can still be wrong: inspect the evidence and answer rather than assuming citations prove correctness.

## Substituting public sources

There is no arbitrary-source config/upload feature in V1. To adapt a public GitHub Markdown course while preserving these identifiers, make a focused reviewed source change:

1. Change the explicit repository mapping and GitHub fetch allowlist in `packages/course-grounding/src/index.ts`; retain public visibility/default-branch/hash/path/size validation.
2. Update source repository allowlists/types in `packages/contracts/src/provider-control.ts`, `packages/contracts/src/history.ts` and course-source types. Search for `JMU-Data` to locate every contract/test boundary; never broadly disable validation.
3. Keep local-only evidence flow and truthful repository/commit URLs. Review upstream licenses and exclude private/assessment/student content even in a public tree.
4. Add synthetic positive, unsupported, hash-mismatch and Cloud-isolation fixtures. Run the full deterministic/security gates, then bounded read-only live public-source retrieval checks.

Adding new course identifiers is also a code/contract change. Do not advertise the unchanged build as supporting a new source, private upload, LMS or unrestricted repository import. Tests contain synthetic snippets rather than redistributed upstream course text.

## Earlier demo-course answer

This Owner-provided capture illustrates a Local demo-course answer from an earlier interface. It does not show an expanded citation panel or establish answer correctness for LAITA Public V1. [Media provenance](SCREENSHOTS.md).

![Owner-provided earlier demo-course Local answer](assets/screenshots/laita-course-grounding.png)
