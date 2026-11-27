# Local History & Review

Open `/history` through the same protected operator HTTPS entry. All records and Problems views support search/filter and source/provider/model/execution inspection. Feedback and operator review are local writes. Problems include recorded failures, incomplete capture, reports, Not helpful feedback, suspicion signals and confirmed issues; pending review alone is not a failure.

The existing SQLite store retains full text questions, successful transcripts, answers, snapshot course/commit identity, citations, diagnostics, feedback and review state. Its schema migration/recovery behavior is tested with synthetic databases. Archival browsing never calls Local or Cloud. Execution detail describes recorded events, not guessed missing phases.

New conversation clears active model context, not saved history. No automatic expiry/deletion schedule or encrypted-at-rest storage is implemented. Protect your account/disk and runtime directory. Preserve the store before diagnosing capture or migration failures; do not blindly delete/recreate it to hide a problem. Raw microphone/generated audio is temporary and is not archived in the store.

LAITA is one Owner installation with separate Admin, Demo Teacher and Demo Student credentials, not a multi-user school platform. Admin retains the existing local Owner History scope, including older records; the practice accounts use scoped principal/course History. Canvas Teacher retains origin/course/identity restrictions. A role selector or session reference does not transfer access. Canvas Student View's Test Student is **not** the source of the local Demo Student History. See [roles and Canvas](CANVAS.md).

## Manage local history

Open **Manage local history** in the History results. **Check local storage** shows the current scope's conversation and turn counts and the byte size of retained question/transcript text, source data, answer/event documents, feedback reasons and review notes. The count covers turns with retained History. SQLite pages, free space, other scopes, accounting, backups and downloads are outside this estimate.

1. Open a record and expand **Manage local history** to select its whole conversation. To select by date, use the controls on the results page and enter both UTC dates, up to 366 days. The dates include both calendar days and match each turn's creation time. Search filters and pagination do not affect this selection. Operations accept up to 250 turns at a time.
2. **Download private JSON** saves the selected turns in insertion order, with text, answers, sources, diagnostics, feedback and review annotations. Exports are limited to 3 MiB of turn data and contain no separate provider usage or reconciliation records. Keep downloads in protected local storage. The app sends the export only to your signed-in browser over the same History connection.
3. **Preview deletion** shows the number of affected conversations and turns. Verify the selection, then choose **Confirm deletion** or **Cancel deletion**. The preview expires after two minutes and belongs to the same signed-in session and browser tab. A change to the selected turns or access requires a fresh preview. If the result is uncertain, refresh History and verify it before retrying.

Deletion removes the selected turns, their answers, traces and feedback, and any conversation left empty. Use **New conversation** in the associated chat before deleting an open conversation. Pending capture, incomplete recording, unresolved suspicion and Owner-confirmed issues block deletion of the selection to preserve active work and safety/recovery evidence. Use a narrower date selection where appropriate. Future Teacher History counts and summaries draw from the remaining Student records in their authorized context. Accounting, reconciliations, policy and migration history, operational logs and other conversations or out-of-range turns remain.

SQLite may reuse freed pages without reducing the file size. A deletion from active History does not provide secure erasure or reach existing backups, downloaded exports or browser copies. A restored backup can bring deleted records back. Follow the existing protected backup and recovery procedure when an investigation or migration requires preserving data. [Backup and recovery](DEPLOYMENT.md#explicit-update-and-recovery)

## Admin diagnostic lookup

Sign in as local **Admin** and open **History & Review**. Open a retained record, expand **Execution trace / identifiers**, and copy the complete value marked **Correlation**. If the record says **unobserved**, it has no reference to look up. Select **Back to results**, expand **Find a local diagnostic**, paste the reference and select **Look up reference**.

The lookup uses the latest 2,000 turn ordinal positions in the existing SQLite archive. A unique match shows the recording status, turn outcome and up to 256 observed stage names with their server or browser origins. Missing, older and ambiguous references return no match. A stage without an event remains unobserved. The lookup makes no provider request, writes no History and returns no text, answers, event details, identifiers, feedback or usage records.

MongoDB verifier outcomes have no support reference in this version. Diagnostic lookup is part of the local, single-operator dashboard. The full Admin record view and the existing History retention rules still apply.

## Teacher History plugin

Initialize separate practice Teacher/Student credentials using [Getting Started](GETTING-STARTED.md). The **Demo Student** signs in, selects a currently authorized course and asks non-sensitive questions. Real questions/answers are retained in local SQLite in that account/course context. An entirely new installation returns **0 / empty**; neither the tool nor the installer must fabricate records.

Sign in as the authorized **Demo Teacher**, select the same course and choose the **History** tool in Teacher Chat. Ask how many questions were asked or request a bounded recent-question summary. Wrong course, missing grant, disabled account or revoked/expired session must fail closed. General Chat and optional Canvas Chat have separate paths.

A legacy `LAITA_HISTORY_SAMPLE_ID` setting, if still configured, refers to an older standalone sample. It is not a Canvas Student View account and is not automatically migrated into a new Demo Student/course scope.

**Deferred in v0.3.0:** a persistent, restart-surviving *support reference* for failed History Summary. Normal count/summary/error states remain. Existing Admin lookup for a genuinely retained turn is separate from this deferred failure-diagnostic feature.

## Dashboard example

This Owner-provided capture shows an earlier History record-detail view for a public demo-course question: retained answer, requested/actual Local model, Sources, execution detail, feedback and operator annotation. It is an illustration, not evidence of LAITA Public V1's answer correctness or student deployment. The UI text and timestamp are preserved; no student identifiers, credentials or private host/path are visible. [Source/privacy review](SCREENSHOTS.md).

![Owner-provided single-operator History record detail](assets/screenshots/laita-history-review.png)

## Date filters

API `since` / `until` filters use canonical UTC timestamps with exactly three millisecond digits (`YYYY-MM-DDTHH:mm:ss.sssZ`), matching retained timestamps and SQLite text ordering. Normalize an integration's date with `Date.toISOString()` before submitting it. Invalid calendar dates and noncanonical precisions/offsets return 400 before querying storage; archived filtering never invokes a provider.
