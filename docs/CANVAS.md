# Optional Canvas course App — Public v0.3.0

Canvas is **optional**. Standalone Local Chat, source grounding and History do not require an LMS. The released version supports **course-level LTI 1.1 / Paste XML** signed Instructor and Learner entry, mapped to currently authorized practice roles. A **separate Canvas REST token** is required for the Teacher to read/write limited Canvas resources. The LTI consumer key/shared secret cannot read/write assignments and must not be mistaken for a REST token.

This is one operator's self-managed installation with separate Admin and fixed practice Teacher/Student credentials, **not** a real multi-user school service. Only configure an authorized test course with non-sensitive content; school policies may disallow course-level External Apps or LTI 1.1. No real student records, live institutional configuration, universal Canvas compatibility or physical-device success is claimed.

## 1. Install and initialize standalone access

Complete [Getting Started](GETTING-STARTED.md#initialize-accounts-and-course-access). With LAITA stopped, run `npm run owner:setup` for Admin, then `npm run demo:setup -- IA340` (or `IA342`) for separate Demo Teacher and Demo Student passphrases and one initial course. Admin may subsequently grant/revoke supported courses. Keep the runtime and config private, outside Git. You can use LAITA locally even if Canvas is never configured.

The reference HTTPS Caddyfile is loopback-only. The Canvas browser must reach your own trusted LAITA HTTPS origin. A separately reachable/protected remote origin requires its own reviewed network setup and is not created by this guide. Never expose the API's loopback port directly.

## 2. Prepare an authorized Canvas course App

Confirm that your Canvas permissions allow **Settings → Apps → View App Configurations → + App → Paste XML** (labels vary). The integration currently uses **LTI 1.1 signed launch**, not LTI 1.3 or school-wide registration. Identify your allowed Canvas HTTPS origin, numeric course ID, Instructor user ID, and the **separate numeric Learner user ID** if the mapped Learner launch is enabled. Generate a unique consumer key and shared secret; keep them in your own password manager for the Canvas App and interactive setup.

A Canvas **Student View Test Student** can be used in certain sandbox submission exercises, but is not proof that an External App can be launched as a signed Learner from Student View. If your course can legitimately issue a Learner launch, validate that entry separately. A Learner never receives Teacher/REST/Admin authority simply by launching the App.

## 3. Save the protected LTI configuration

Using the **same** operator configuration and stopped instance, run:

~~~bash
export APP_CONFIG_JSON="$(cat "$HOME/.local/share/laita/config/application.json")"
export LAITA_CANVAS_CONFIG_FILE="$HOME/.local/share/laita/config/canvas.json"
npm run canvas:setup -- --demo-course IA340
~~~

The hidden prompts ask for the Canvas origin, numeric course/Instructor IDs, the mapped Learner user ID when `--demo-course` is supplied, and launch credentials. They create a protected `0600` file outside Git. Match the same supported practice course used in the identity setup. Do not enter actual secrets in shell arguments, chat messages, screenshots or GitHub Issues. This setup refuses silent overwrite; use documented rotation/disable flows rather than editing security fields casually.

Start your foreground API with `APP_CONFIG_JSON` and `LAITA_CANVAS_CONFIG_FILE` exported. Shell exports do not automatically configure an already-running LaunchAgent. A missing/invalid/inaccessible protected file disables optional Canvas launch without disabling standalone Local Chat.

## 4. Install the course App with Paste XML

Generate XML from the configured LAITA public HTTPS origin:

~~~bash
npm run --silent canvas:xml -- --demo
~~~

In your authorized Canvas course, select **Paste XML**, enter the generated App's consumer key and shared secret, paste the XML and add the App. Keep the recommended top-level/new-window target; do not disable framing/CSRF protections to make an embedded copy work. Launch as the configured Instructor, check the correct Teacher/course scope, and separately test an authorized Learner if available. Wrong role, origin/course/user, stale signature, replayed nonce and revoked local grant must fail closed.

No REST API token is needed merely to open the signed App. If installation is blocked by the school, stop; do not bypass Canvas administration policy.

## 5. Set up optional Canvas REST authoring

Only the appropriately signed Canvas **Teacher** can use these tools, and only with a separate time-limited Canvas REST token identifying the same Instructor in the same authorized course. The token needs the exact Canvas API rights for your enabled actions (course/teacher reads; Page/Assignment Group/Assignment/Module catalog reads; specific create/append/readback calls). Use a private, owner-only `0600` file outside Git, such as:

~~~json
{
  "origin": "https://canvas.example.test",
  "courseId": "42001",
  "teacherId": "73001",
  "expiresAt": "2027-01-01T00:00:00.000Z",
  "canvasToken": "<replace locally with your time-limited REST token>",
  "assignments": { "editableIds": [] },
  "modules": { "organizeSavedResources": true }
}
~~~

This is an **example, not an executable configuration**. Use the exact signed course/origin/Teacher, a valid expiry and actual token in the protected file. The optional `assignments` entry no longer needs a fixed `groupId`; legacy fixed `groupId` remains accepted. `editableIds` restricts title edits on existing assignments. Enabling `"modules": { "organizeSavedResources": true }` **once** allows the Teacher to refresh and select newly saved Pages/Assignments/Modules without editing their IDs into JSON after every creation. Legacy static `moduleIds`, `pageIds` and `assignmentIds` are supported separately for operators who prefer pre-approved targets.

Start the foreground API with the protected REST-file path:

~~~bash
export LAITA_CANVAS_REST_FILE="$HOME/.local/share/laita/config/canvas-rest.json"
APP_CONFIG_JSON="$(cat "$HOME/.local/share/laita/config/application.json")" npm start
~~~

Preserve the already exported `LAITA_CANVAS_CONFIG_FILE` as applicable. Configuration changes invalidate active previews. The same permissions are rechecked before authoring and before returning results. Raw tokens must never enter code, screenshots, Github or a model prompt.

## 6. Preview and create a Page

In a signed Canvas Teacher view, use the Canvas Page editor. A source-grounded Local AI suggestion may be generated, inspected and edited first; it is not itself a write. Select **Preview Canvas Page** and inspect the exact target and body. Only **Create unpublished page** dispatches a Canvas write. After authorizing the write, LAITA checks the returned resource. If the result is uncertain or unverified, inspect Canvas before attempting another operation. Publishing, if desired, happens afterwards in Canvas itself.

## 7. Create and rename Canvas assignments

Open **Canvas Assignments**, select **Create unpublished assignment** and click **Refresh Assignment Groups**. LAITA reads the complete bounded Group catalog from the authorized course. **The Teacher**, not the AI, chooses the destination Group. On incomplete/unavailable results, correct the issue and refresh; a stale Group selection is not allowed.

Enter title, final edited content, nonnegative points, supported submission type(s), and optional UTC due date. The AI suggestion may edit body text but cannot choose the Group. **Preview Canvas Assignment** shows the chosen Group, bound course, exact content and Unpublished visibility. **Create unpublished assignment** writes once after renewed authority/scope checks and reads back the saved Group and resource. A configured `editableIds` list also enables a separate *title-only* edit of one approved existing Assignment. No grade, automatic publication, deletion or hidden student-visible effect is performed by a preview.

## 8. Create and organize unpublished Canvas modules

The standard v0.3.0 flow uses three independent creates, then a separate resource-organizing action:

1. Create an **Unpublished Assignment** and an **Unpublished Page** with the Teacher's explicit previews/confirmations.
2. Open **Canvas Modules**, enter a new Module title and explicitly preview/confirm **Create unpublished module**.
3. Click **Refresh saved Canvas resources**. The current course's saved supported Pages, Assignments and Modules are read with bounded, complete pagination. Source Page/Assignment items may be Published or Unpublished; the **destination Module must be Unpublished**.
4. Select the new Module and the saved Page/Assignment, optionally arrange 2–10 items in order, **Preview → Confirm**, then inspect the verified append/readback results. A single item can also be added explicitly.
5. If the target, enrollment, catalog, version or permissions change, or a write/readback becomes uncertain, LAITA stops. **Inspect Canvas before retrying**; a lost response can mean the write succeeded.

The dynamic mode requires just the **one-time** protected `organizeSavedResources` setting. It does **not** require copying the new Module ID, Page ID or Assignment ID into the JSON or restarting after each create. The older static allowlist mode is optional and behaves differently. LAITA does not publish Modules, add to already Published destinations, edit source resource bodies, delete content, reorder old items or perform all creates in a single opaque plan.

## Canvas Chat plugin

In your authorized sandbox course, use Canvas **Student View** to create the course’s Test Student. Choose one or more published, individual practice assignments with non-sensitive content. Find their numeric IDs and the Test Student’s numeric ID in your Canvas setup. Add the following optional object to the protected REST JSON using your own IDs. These values are synthetic.

```json
{
  "chat": {
    "testStudentId": "73009",
    "assignmentIds": ["81"]
  }
}
```

Use 1–15 digit IDs with no leading zero. The Test Student ID must differ from the Instructor’s. Approve one to twelve unique assignment IDs. The supported submission types are Text Entry, Website URL and File Upload. The plugin checks one course, one Test Student and one matching assignment per answer.

The same Instructor token needs permission for the exact course and the following additional read operations. For the membership check LAITA applies fixed Canvas filters for the configured ID, active enrollment and `student_view` type. It uses at most one matching identity and follows no pagination links. Use the existing Teacher’s authorized course permissions. If Canvas denies the checks, the plugin remains unavailable.

| Method | Endpoint | Use |
| --- | --- | --- |
| GET | `/api/v1/courses/:course_id/assignments/:id` | Resolve the full title among the explicit allowlist and check assignment type |
| GET | `/api/v1/courses/:course_id/users` | Confirm the one configured ID is an active Student View user using the fixed filters |
| GET | `/api/v1/courses/:course_id/assignments/:id/submissions/:user_id` | Read that Test Student’s observation with Canvas assignment visibility |

Launch through the configured course as the Teacher. In **Ask about**, choose **Canvas (Local)** or **Canvas (Direct)**. Local uses an available tool-capable Local model to select a supported, approved count/score operation from a natural-language question. Direct uses the exact supported form: **How many submissions for Map studio?** or **What is the score for Map studio?** for a synthetic assignment named “Map studio.” Use the unambiguous **full assignment title** for either route. If Local function selection is unavailable, choose Direct explicitly; there is no automatic fallback. The count can be zero or one for this configured Test Student; score answers use the grade for the current supported attempt. Both routes distinguish missing, ungraded, excused and unavailable observations.

The final observation is formatted deterministically from these narrow Canvas responses, without a model generating the answer text. The **Local** route does use the selected Local model for bounded tool selection; **Direct** does not. They exclude other students, class totals, submitted content, attachments and comments. The browser output is session-local and outside retained Chat History. Read a missing or ambiguous assignment response as a request to check the full title and approved configuration. The **Cancel request** button stops an in-flight query. Removing `chat` disables the plugin and restores compatibility with earlier LAITA builds if rolling back. [Canvas course users](https://github.com/instructure/canvas-lms/blob/master/app/controllers/courses_controller.rb) · [Canvas submissions](https://developerdocs.instructure.com/services/canvas/resources/submissions)

## Canvas Teacher feedback

Enable this tool only for non-sensitive practice submissions in your authorized sandbox course. Create the course's Test Student through Canvas Student View, then submit a synthetic attempt to a published, individual Text Entry, Website URL or File Upload assignment. Find the numeric IDs in your authorized Canvas setup. Add the `feedback` field to the protected REST JSON. These IDs are synthetic.

```json
{
  "feedback": {
    "testStudentId": "73009",
    "assignmentIds": ["81"]
  }
}
```

Use 1–15 digit IDs with no leading zero, one to twelve unique assignments, and the same Test Student ID as `chat` if both are enabled. `feedback` has its own assignment allowlist. Group, quiz, anonymously or moderately graded assignments and absent, invisible, missing or excused submissions are outside this flow. Use an already-posted submission or a practice assignment with manual posting enabled. Canvas can otherwise post a submission when an Instructor adds a comment, which could expose previously unposted grades or comments. LAITA checks the posting state before enabling the preview and again before sending the comment. [Canvas submission implementation](https://github.com/instructure/canvas-lms/blob/master/app/models/submission.rb)

Use the same active Teacher token as in step 5. Give it only the necessary scoped permissions where supported. The tool checks the same assignment, course Student View membership and exact submission GET routes listed above. It also requires the submission PUT route `/api/v1/courses/:course_id/assignments/:id/submissions/:user_id` to add one text comment. The request preserves the reviewed plain text by escaping HTML-sensitive characters and binds it to the exact attempt with group commenting disabled. LAITA sends no grade, rubric, attachment or bulk-update fields. Canvas controls notification and comment visibility according to the course settings. [Canvas submissions API](https://developerdocs.instructure.com/services/canvas/resources/submissions)

1. Open **Canvas Test Student feedback** in the signed Teacher view. Select the approved assignment and enter your own plain-text feedback. For a synthetic example, use “Compare the two map legends and explain one difference. 地图 🌍”. The limit is 1,024 UTF-8 bytes, including line breaks. LAITA trims outer whitespace before preview.
2. Choose **Preview feedback**. Verify the course, Teacher, assignment, Test Student, attempt, submission time and exact text. Preview only reads Canvas. Existing comments, grades and submission content do not appear in the preview or enter Chat History. Changing the draft, cancelling or leaving the page clears the visible approval.
3. Choose **Post feedback** only when you intend to record that comment. LAITA rechecks the current Teacher, scope and submission before consuming the preview once. It then reads back a new comment with the expected Teacher, attempt and text. If the target changed before the write, check the target and preview again. When Canvas omits the comment's attempt or the result is otherwise uncertain or unverified, check the submission directly in Canvas before trying again. LAITA does not automatically retry a write.

Preview, recheck, write and readback use separate Canvas requests. Canvas can change between those requests. A local database recovery does not undo a Canvas comment. Remove `feedback` to disable the tool or before rolling back to a build that predates this field. The local schema and stored History are unchanged.

## Verify assignment submissions

The signed Teacher can optionally run [GitHub and MongoDB assignment verification](CANVAS-VERIFICATION.md) for an explicitly configured roster. Each row checks one current attempt. The Test Student-only Canvas Chat and feedback tools keep their own scope.

## 9. Disable, remove, rotate or recover

To disable Canvas authoring, remove the REST file and revoke the token through your authorized Canvas setup. The steps below disable the signed launch itself.

```bash
# Removes only the configured private Canvas file, not credentials or History.
npm run canvas:disable
```

Removal makes the next Canvas launch and next request using a Canvas session fail closed. A server restart also drops browser sessions. In Canvas course Settings, remove the LAITA external App and its navigation entry. Unset `LAITA_CANVAS_CONFIG_FILE` in future API processes. Standalone role credentials and retained History are unchanged. Alternatively, setting the private file's `enabled` field to `false` disables it; do not print its contents for diagnosis.

To rotate the consumer key/shared secret, disable the local connection, generate replacements in your password manager, then rerun **`npm run canvas:setup -- --demo-course IA340`** (or your originally configured supported `IA342` course), supplying both mapped Instructor and Learner numeric Canvas user IDs. Do **not** rerun bare `canvas:setup` for a Learner-enabled installation: it would omit that mapping. Update the course App to match. Existing Canvas sessions are invalidated. The stable course/identity History context is retained; standalone Teacher/Admin can still review it. Changing origin/course/identity selects a different context; no prior records are reassigned automatically. To recover a forgotten local passphrase, stop LAITA and repeat `owner:setup` with the same runtime, then restart.

**Versioned SQLite recovery:** v0.2.0 introduced schema v5 with the Owner verifier, nonce table and role/context columns, retaining v1–v4 migration checksums and legacy Admin-visible History. The v0.3.0 release adds identity, course membership and account migrations **v6–v8**; the database becomes **schema v8**. To return from v0.3.0 to v0.2.0, stop LAITA and restore a **pre-v0.3.0 schema-v5 snapshot** through the [database backup/rollback procedure](DEPLOYMENT.md#explicit-update-and-recovery), together with the matching older build/configuration. A pre-v5 snapshot is only relevant when returning to a **pre-v0.2.0** binary. Post-backup records and credential changes will not be in the restored copy; preserve the newer database separately. Do not delete migration rows or downgrade the schema by hand. Disabling Canvas is the less disruptive way to turn off that integration without rolling back the application.

## Troubleshooting

Public failure responses deliberately omit submitted identifiers and signatures. Diagnose locally; share only synthetic reproductions, error codes and the reviewed revision.

| Symptom                                                  | Local checks                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `403 FORBIDDEN`, suspected invalid signature             | Consumer key/shared secret must match the App exactly; compare privately in the password manager. Check canonical HTTPS public origin, port and launch path, no redirect/rewrite/query string, and the signed Canvas substitutions in the generated XML. Do not log form bodies or signatures. |
| Wrong Canvas user                                        | For Instructor, use the exact numeric Instructor Canvas user ID configured locally; for Learner, use the **separately mapped numeric Learner user ID** supplied with `--demo-course`. A Canvas Student View Test Student is not automatically a signed Learner launch. No automatic admission or masquerading occurs.                                                                                                   |
| Wrong course                                             | Install/launch the App from the one configured numeric course, not a copied App in another course.                                                                                                                                                                                             |
| Wrong role                                               | A mapped Teacher launch must carry `Instructor` or `urn:lti:role:ims/lis/Instructor`; a mapped Student launch must carry `Learner` or `urn:lti:role:ims/lis/Learner`. Both roles together are rejected, and the signed user/course must match. TA, Designer or platform Administrator alone is insufficient.                                                                                                                                             |
| Stale/future timestamp                                   | Synchronize the LAITA host and Canvas clocks. The window is ±300 seconds; do not enlarge it to mask clock errors.                                                                                                                                                                              |
| Replayed launch / reloading POST                         | Launch afresh from Canvas for a new nonce. Do not resubmit a captured form or clear the nonce table. Nonces survive API restarts until the freshness window ends.                                                                                                                              |
| `503 SERVICE_UNAVAILABLE`                                | Initialize the local Owner credential. Check the API process's optional config path, private parent/file permissions (0700/0600), ownership, JSON schema, enabled state and secret lengths. Missing/disabled config does not fall back to unsigned access.                                     |
| `401 UNAUTHENTICATED` after prior success                | Session expired, API restarted, credential/config rotated/disabled, or another tab changed role. Re-launch from Canvas or sign in standalone.                                                                                                                                                  |
| `429 RATE_LIMITED`                                       | Wait a minute. Login has 20 attempts/minute and one outstanding password derivation; Canvas has 120 launch attempts/minute. Use an independently protected Owner entry.                                                                                                                        |
| Empty/denied History                                     | Check current role and Canvas context. Student/Teacher cannot read another role's records; Canvas sees only its configured context. Admin can inspect older retained records.                                                                                                                  |
| No new tab / certificate / browser private-network block | Trust only your own local HTTPS CA, confirm new-window App configuration and browser/institution policy. Use standalone while resolving the environment; never disable TLS, Origin checks or framing/cookie protections.                                                                       |

Deterministic launch and Page workflow tests use synthetic state. Preview, explicit creation and readback have synthetic desktop and mobile browser coverage. Real Canvas installation/substitution/origin/new-window behavior and real browser-to-loopback/private-network behavior require Owner checks and are **NOT_RUN** unless explicitly recorded for this Public revision. The Owner-authorized sandbox demo is documented in [media provenance](SCREENSHOTS.md); it does not establish interoperability for every environment. Do not publish captures from a private deployment.
