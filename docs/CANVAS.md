# Optional Canvas course App

This early-adopter reference connects **one Owner, one Canvas course and one Instructor identity** to the existing local Teacher role. Admin, Teacher and Student are three views operated by that same Owner, not three real people. The signed launch enters the same local API, Chat, course grounding, SQLite and History. A separate optional REST configuration enables unpublished Page, Assignment and Module creation, approved Assignment renaming, and adding approved Pages or Assignments to unpublished Modules. The integration does not provision Canvas accounts or memberships.

## 1. Install and initialize standalone access

Complete [Getting started](GETTING-STARTED.md), including the pinned Node/npm installation, build, operator configuration, models and loopback HTTPS edge. No Canvas configuration, API token, OpenAI key or cloud speech service is needed for standalone use. Credential/configuration checks require macOS/Linux POSIX ownership; Windows is unsupported and fails closed.

Stop LAITA before credential maintenance. In its checkout, load the same operator configuration/runtime that you will use to start the API:

```bash
export APP_CONFIG_JSON="$(cat "$HOME/.local/share/laita/config/application.json")"
npm run owner:setup
```

Type and repeat one Owner passphrase in the Terminal's hidden prompts. Use at least 15 characters (maximum 1024 UTF-8 bytes), preferably a unique password-manager-generated passphrase. Input is not echoed, accepted from redirected stdin, passed as a command argument or read from a password environment variable. There is no built-in usable password. SQLite stores only a random 128-bit salt, a 256-bit scrypt verifier and a random credential revision. The fixed scrypt parameters are N=131072, r=8, p=1; the application permits one derivation at a time and 20 login attempts per minute. A pinned Express rate-limit middleware additionally bounds the authentication entry and control routes to a shared 600 requests/minute using one constant Owner key, without collecting IP/person identities.

Start LAITA and its HTTPS edge as documented. Open `https://localhost:3443`, choose Admin, Teacher or Student and enter the same Owner passphrase. Sign out to change role. Simultaneous roles require separate browser profiles: a cookie is shared by tabs in one profile. Never give this passphrase to students or other instructors. Re-running `owner:setup` replaces the credential and invalidates existing role sessions without deleting History.

| Entry              | Authority and History                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Standalone Admin   | Local administrative control APIs and all Owner History, including pre-v0.2 records                                                   |
| Standalone Teacher | Chat and Teacher History, including this Owner's Canvas contexts; cannot use Admin control APIs                                       |
| Standalone Student | Chat and Student History/feedback; cannot review records as Owner or use Admin control APIs                                           |
| Canvas Teacher     | Same Teacher identity, with History restricted to the configured Canvas origin/course/identity context; cannot use Admin control APIs |

Sessions use an opaque, random, Secure/HttpOnly/SameSite=Lax cookie with an eight-hour maximum lifetime. No passphrase or bearer is saved in browser storage. Server-side browser sessions are transient; API restart signs them out. Conversation references are bound to both the authenticated session and each page's random client reference. Copying a conversation reference into a different role/session does not transfer access. The existing one-operation BUSY/no-queue limit remains global.

## 2. Prepare the optional Canvas connection

Your Canvas permissions must allow **course-level external Apps installed with Paste XML and a consumer key/shared secret**. Ask your Canvas administrator about availability if this UI is disabled. This implementation does not support institution-wide registration or LTI 1.3.

The Owner's browser must reach both Canvas and the configured LAITA HTTPS origin. For an instructor working on the same Mac, the existing trusted `https://localhost:3443` entry can be used; the browser posts the launch form to localhost. Canvas servers do not need to call the LAITA API. Browser private-network/loopback policies or institution policy may block this. Confirm on your own authorized setup. The supplied Caddyfile stays loopback-only. A remote browser requires a separately configured, independently protected Owner entry with the exact public origin and fixed forwarding headers; it is outside this reference setup. Do not open the loopback API or expose this reference as a hosted service.

Identify your own numeric Canvas **course ID** and **user ID** using your authorized Canvas UI/course profile or your Canvas administrator. The LTI `context_id` and opaque `user_id` are not substitutes for these numeric Canvas values. The signed launch by itself makes no Canvas REST calls. The integration does not ingest rosters, grades, submissions or Canvas course material for Chat. Generic examples are `https://canvas.example.test`, course `42001`, user `73001`; these are synthetic and will not connect to a service.

Generate a new random consumer key (at least 16 characters) and shared secret (at least 32 random characters, ideally 256 bits) in your password manager. Store them privately there for transfer into the Canvas App settings and the next hidden Terminal prompts. These are launch credentials, not a Canvas password or Canvas REST API token. Do not use institutional login credentials. Do not put secrets into shell commands/history, Git, issue reports, screenshots, application JSON or browser local/session storage.

## 3. Save one private local configuration

Use the same Terminal/operator configuration as above:

```bash
umask 077
mkdir -p "$HOME/.local/share/laita/config"
chmod 700 "$HOME/.local/share/laita/config"
export LAITA_CANVAS_CONFIG_FILE="$HOME/.local/share/laita/config/canvas.json"
npm run canvas:setup
```

The hidden prompts request Canvas HTTPS origin (origin only, no trailing slash/path), numeric course ID, numeric Owner user ID, consumer key and shared secret. The command creates a new 0600 file outside Git in a canonical owner-only directory; it refuses to overwrite an existing file. All ancestors must be trusted. No credential values are printed. The shared secret must be available for HMAC verification, so it resides in this protected local file, separate from SQLite, rather than as a password hash. Keep your account/disk protected; no new encrypted vault is claimed.

Start the existing API with **both** `APP_CONFIG_JSON` and `LAITA_CANVAS_CONFIG_FILE` exported in its process environment. The optional file is revalidated on launch and Canvas-session access. Absent, unreadable, non-private, malformed or disabled configuration closes Canvas access while standalone remains usable. Do not place Canvas secrets in `APP_CONFIG_JSON`.

The existing macOS LaunchAgent does not automatically inherit shell exports or configure Canvas. The Canvas instructions use the foreground API. Automated Canvas environment injection into that lifecycle is not included; do not assume shell exports configure a running service. Standalone credential access works with the existing lifecycle and its configured runtime.

## 4. Install the course App with Paste XML

Generate the configuration XML from the exact `access.publicOrigin` in your loaded application configuration:

```bash
# --silent keeps npm's banner out of the XML. This output contains no credentials.
npm run --silent canvas:xml > /tmp/laita-course-app.xml
```

Read the file locally and copy its XML. It includes the fixed `/api/v1/canvas/launch` URL, Canvas substitutions for API domain/course/user IDs, anonymous privacy, instructor/admin navigation visibility and a new-window target. Do not add names, email, roster or grade-service permissions.

In **the one intended Canvas course**, open **Settings → Apps → View App Configurations → + App** (wording varies). Select **Paste XML**, enter a local display name such as LAITA, enter your consumer key and shared secret from the password manager, paste the generated XML and add the App. If installation is denied, stop and use standalone LAITA; there is no registration or security-policy bypass in this project.

Reload the course navigation and launch LAITA as the configured Instructor in a **new top-level tab/window**. It should enter Teacher without another LAITA passphrase prompt. Verify the `Owner · Teacher · Canvas` label and try a non-sensitive synthetic question, then History. The application disallows framing; if Canvas tries an iframe, verify the App's new-window configuration. Do not weaken CSP or cookie protections to make embedding work.

The verifier requires the exact HTTP Canvas Origin, signed `$Canvas.api.domain` host (including any configured port), signed numeric course/user substitutions, an Instructor role, OAuth consumer key/version/HMAC-SHA1 signature, timestamp within ±300 seconds, and a previously unused nonce. The signature URL is the configured canonical HTTPS launch URL, never an untrusted Host or forwarded URL. Query strings, duplicate form parameters, OAuth tokens and alternate signature methods are rejected. Only after these checks and atomic persistent nonce consumption does the API issue a Teacher cookie. Extra signed values cannot grant Admin or create users/memberships. Other public grounding sources remain the existing fixed public-source demonstrations, not Canvas course content or enrollments.

## 5. Set up optional Canvas REST authoring

Finish the signed launch setup first. From your own authorized Canvas environment, obtain a short-lived REST token for the **same Instructor identity** and the one configured course. Use a separate REST token alongside the LTI consumer key and shared secret. Grant the scopes needed for the authoring actions you use, where scoped tokens are supported.

For the Page flow the backend uses these Canvas REST operations. The Assignment, Module, [Canvas Chat](#canvas-chat-plugin) and [Teacher feedback](#canvas-teacher-feedback) sections list the operations for those tools.

| Method | Endpoint                                        | Use                                                                             |
| ------ | ----------------------------------------------- | ------------------------------------------------------------------------------- |
| GET    | `/api/v1/users/self`                            | Match the token holder to the signed Instructor's numeric ID                    |
| GET    | `/api/v1/courses/:course_id`                    | Check the exact available course and the Instructor's active Teacher enrollment |
| POST   | `/api/v1/courses/:course_id/pages`              | Create one unpublished Page after confirmation                                  |
| GET    | `/api/v1/courses/:course_id/pages/page_id:<id>` | Verify the created Page by numeric ID                                           |

Create a separate JSON file in the protected configuration directory from step 2. Use a private editor and the same OS account that runs LAITA. Set the file to mode `0600` and keep the directory at `0700`, outside Git and without symlinks. The JSON object requires these five string fields. The optional `assignments`, `modules`, `chat` and `feedback` settings are described below.

| Field         | Value                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------- |
| `origin`      | The same canonical HTTPS Canvas origin as `canvasOrigin` in your signed launch configuration   |
| `courseId`    | The same Canvas course ID, 1–15 decimal digits with no leading zero                            |
| `teacherId`   | The same Canvas user ID as `userId`, 1–15 decimal digits with no leading zero                  |
| `expiresAt`   | The token's expiry in UTC ISO format with milliseconds, for example `YYYY-MM-DDTHH:mm:ss.sssZ` |
| `canvasToken` | Your own Canvas REST bearer token, entered only in this protected local file                   |

With the regular Canvas launch and application settings still exported, start the foreground API as in [Getting started](GETTING-STARTED.md):

```bash
export LAITA_CANVAS_REST_FILE="$HOME/.local/share/laita/config/canvas-rest.json"
npm start
```

Export the file path only. Avoid putting the token in environment variables, shell commands, exported logs, screenshots or browser storage. Removing the REST file stops authoring operations at the next check. Restart without the variable to remove the feature's API routes. To rotate the token, replace its protected file with a matching current expiry and obtain a fresh preview. The optional REST setup uses the current Public v4 operator profile.

## 6. Preview and create a Page

1. Open the signed Canvas Teacher launch. Expand **Create a Canvas Page** and enter a title and your edited Markdown. For a synthetic example, use the title “Compare two maps” and the body `## Studio exercise` followed by a blank line and `Explain **one** difference between two maps.`
2. Choose **Preview Canvas Page**. Review the displayed Canvas origin, course, numeric Teacher ID, title and body. **Exact HTML sent to Canvas** shows the canonical content. Preview makes only identity and course reads. The current preview expires in five minutes. Editing the fields calls for a new preview.
3. Choose **Create unpublished page** to send that content once. LAITA rechecks the current session, connection, token identity and course before dispatch. It requests Teacher editing and disables update notifications in the creation payload.
4. A verified result means Canvas returned the created Page by ID with matching title, canonical body, unpublished state and Teacher editing. If the result is unverified, uncertain or interrupted, inspect your course's Pages in Canvas before taking another action. LAITA does not retry a write. A local backup or rollback cannot undo a Page already created in Canvas.

The Page panel accepts a title up to 250 UTF-16 code units and Markdown up to 12,000 in the editor, subject to a 16,000 UTF-8 byte limit on canonical HTML. It supports headings, paragraphs, lists, emphasis and code. Links, images and raw HTML are rendered as text. Use non-sensitive, operator-authored content. The preview is kept in transient memory and does not create a History record. The only write in this panel is unpublished Page creation. Existing Page edits, assignments, modules, feedback, publishing and participant administration are outside this workflow.

## 7. Create and rename Canvas assignments

Assignment authoring uses the same signed Teacher and optional REST token. Add an `assignments` object to the protected REST JSON to enable it. Use the numeric ID of an existing assignment group in the configured course and the IDs of the assignments that this operator may rename. These are synthetic example values.

```json
{
  "assignments": {
    "groupId": "72",
    "editableIds": ["81", "82"]
  }
}
```

Use 1–15 digit IDs with no leading zero. Keep `editableIds` at twelve unique IDs or fewer. An empty list enables creation only. A REST file containing the original five fields still enables Page creation. To disable only Assignment authoring, remove the `assignments` object. Changes to the REST file invalidate active previews.

The same token needs access to the selected course and caller identity. For creation it needs permission to read the configured assignment group, create an unpublished assignment and read the result. Renaming also requires read and update access for the listed assignments. Where scoped tokens are supported, the additional Canvas operations are:

| Method | Endpoint                                                            | Use                                                          |
| ------ | ------------------------------------------------------------------- | ------------------------------------------------------------ |
| GET    | `/api/v1/courses/:course_id/assignment_groups/:assignment_group_id` | Check the configured group                                   |
| POST   | `/api/v1/courses/:course_id/assignments`                            | Create one unpublished assignment                            |
| GET    | `/api/v1/courses/:course_id/assignments/:id`                        | Check an approved rename target or verify a saved assignment |
| PUT    | `/api/v1/courses/:course_id/assignments/:id`                        | Save the reviewed title only                                 |

1. In the signed Teacher view, open **Canvas Assignments**. Choose **Create unpublished assignment**, then enter a title, edited non-sensitive Markdown, nonnegative points and at least one of Text Entry, Website URL or File Upload. An optional due date and time is interpreted as UTC. The title and Markdown limits match the Page editor.
2. Choose **Preview Canvas Assignment**. Check the course, Teacher ID, destination group and exact draft. For a rename, choose **Rename approved assignment** and select an approved ID. Preview shows the current title and publication state alongside the proposed title. An unchanged title offers no Save action.
3. Choose **Create unpublished assignment** or **Save assignment title**. LAITA rechecks identity, scope and the previewed target before dispatch. The final payload asks Canvas to send no update notification. Assignment content and grading settings on existing assignments are outside the rename operation.
4. A verified result comes from reading the saved assignment by ID. If the result is unverified, uncertain or interrupted, inspect Assignments in Canvas before another action. LAITA does not automatically retry writes. Local rollback cannot undo a write already accepted by Canvas.

Preview reads the exact course and selected resource. It makes no external write. Pages, Assignments and Modules share one five-minute preview, so a newer preview invalidates the previous one. No preview creates a History record. Assignment publishing, deletion, verification and grading are outside these controls.

## 8. Create and organize unpublished Canvas modules

Add a `modules` object to the same protected REST file. Use numeric IDs from the single configured course. This example uses synthetic IDs.

```json
{
  "modules": {
    "moduleIds": ["61"],
    "pageIds": ["9002"],
    "assignmentIds": ["81"]
  }
}
```

Each list allows up to twelve unique IDs of 1–15 digits with no leading zero. Empty lists enable module creation while leaving item links unavailable. A module ID returned by creation must be approved in `moduleIds` before you can add items through LAITA. After changing the file, reload the Teacher view to update the choices. Removing `modules` disables these controls. Other optional authoring settings can be used independently.

Grant the same Teacher token access to read and manage modules in the selected course. For a scoped token, enable the additional operations you use. Canvas returns the linked items with the single-module read.

| Method | Endpoint                                           | Use                                                    |
| ------ | -------------------------------------------------- | ------------------------------------------------------ |
| POST   | `/api/v1/courses/:course_id/modules`               | Create one empty unpublished module                    |
| GET    | `/api/v1/courses/:course_id/modules/:id`           | Check an approved destination and verify the result   |
| POST   | `/api/v1/courses/:course_id/modules/:id/items`     | Add one approved Page or Assignment                    |
| GET    | `/api/v1/courses/:course_id/pages/page_id:<id>`    | Resolve an approved Page's current title and slug     |
| GET    | `/api/v1/courses/:course_id/assignments/:id`        | Check an approved Assignment's identity and type      |

1. Open **Canvas Modules** in the signed Teacher view. Enter a title such as “Map studio” to create a module, or choose one approved destination and one approved item to add.
2. Choose **Preview Canvas Module change**. Check the course, Teacher, title or item, and destination. Preview only reads. Link previews require an unpublished module with fewer than 25 items and a complete inline item list. Existing duplicate links are rejected. Assignment links support regular Text Entry, Website URL and File Upload assignments. Quizzes, discussions and external tools are outside this flow.
3. Choose **Create unpublished module** or **Add item to module** once. Each approval covers a single change. A module stays unpublished, and the link adds the existing resource at the end without changing its content or publication settings. LAITA rechecks current authority and the target before dispatch. The final check and write use separate Canvas requests, so concurrent changes in Canvas can still intervene.
4. LAITA reads back the module or appended item. If the outcome is unverified, uncertain or interrupted, inspect Modules in Canvas before trying again. LAITA does not retry automatically. A local rollback cannot undo a write accepted by Canvas.

Module publishing, reordering, deletion and other item types remain in Canvas. If you roll back to an earlier LAITA build without Modules, remove the `modules` object before starting that build so it can read the remaining REST settings. See the [Instructure Modules REST API](https://developerdocs.instructure.com/services/canvas/resources/modules).

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

Launch through the configured course as the Teacher and open **Canvas Chat plugin**. For a synthetic assignment named “Map studio,” submit **How many submissions for Map studio?** or **What is the score for Map studio?** Use the full title when there are similar assignments. The count can be zero or one for this sample. Score answers use the grade for the current supported attempt. The plugin distinguishes missing, ungraded, excused and unavailable observations.

Answers are generated from these narrow Canvas responses without a model. They exclude other students, class totals, submitted content, attachments and comments. The browser output is session-local and outside retained Chat History. Read a missing or ambiguous assignment response as a request to check the full title and approved configuration. The **Cancel request** button stops an in-flight query. Removing `chat` disables the plugin and restores compatibility with earlier LAITA builds if rolling back. [Canvas course users](https://github.com/instructure/canvas-lms/blob/master/app/controllers/courses_controller.rb) · [Canvas submissions](https://developerdocs.instructure.com/services/canvas/resources/submissions)

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

The signed Teacher can optionally run [GitHub assignment verification](CANVAS-VERIFICATION.md) for an explicitly configured roster. Each row checks one current attempt. The Test Student-only Canvas Chat and feedback tools keep their own scope.

## 8. Disable, remove, rotate or recover

To disable Canvas authoring, remove the REST file and revoke the token through your authorized Canvas setup. The steps below disable the signed launch itself.

```bash
# Removes only the configured private Canvas file, not credentials or History.
npm run canvas:disable
```

Removal makes the next Canvas launch and next request using a Canvas session fail closed. A server restart also drops browser sessions. In Canvas course Settings, remove the LAITA external App and its navigation entry. Unset `LAITA_CANVAS_CONFIG_FILE` in future API processes. Standalone role credentials and retained History are unchanged. Alternatively, setting the private file's `enabled` field to `false` disables it; do not print its contents for diagnosis.

To rotate consumer key/shared secret, disable the local connection, generate replacements in your password manager, run `canvas:setup` again and update the course App to match. Existing Canvas sessions are invalidated. The stable course/identity History context is retained; standalone Teacher/Admin can still review it. Changing origin/course/identity selects a different context; no prior records are reassigned automatically. To recover a forgotten local passphrase, stop LAITA and repeat `owner:setup` with the same runtime, then restart.

Schema v5 adds the singleton verifier, bounded nonce table and role/context columns to the existing database. v1–v4 migration SQL/checksums are unchanged. Pre-v0.2 History is retained and visible only to local Admin. Older binaries refuse this newer schema: reverting application code alone is insufficient. For rollback, stop LAITA and use the existing [database backup/rollback procedure](DEPLOYMENT.md#explicit-update-and-recovery) with a **pre-v5** backup. Post-backup records and new credential state will not exist in that restored copy; preserve the newer database separately. Do not delete migration rows or downgrade the schema by hand. Disabling Canvas is the least disruptive rollback of the integration itself.

## Troubleshooting

Public failure responses deliberately omit submitted identifiers and signatures. Diagnose locally; share only synthetic reproductions, error codes and the reviewed revision.

| Symptom                                                  | Local checks                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `403 FORBIDDEN`, suspected invalid signature             | Consumer key/shared secret must match the App exactly; compare privately in the password manager. Check canonical HTTPS public origin, port and launch path, no redirect/rewrite/query string, and the signed Canvas substitutions in the generated XML. Do not log form bodies or signatures. |
| Wrong Canvas user                                        | Launch from the configured Owner's Canvas login, with the exact numeric user ID in local setup; masquerading/testing as another participant is not supported. No automatic admission occurs.                                                                                                   |
| Wrong course                                             | Install/launch the App from the one configured numeric course, not a copied App in another course.                                                                                                                                                                                             |
| Wrong role                                               | Course launch must carry `Instructor` or `urn:lti:role:ims/lis/Instructor`. Student, TA, Designer or platform Administrator alone is insufficient.                                                                                                                                             |
| Stale/future timestamp                                   | Synchronize the LAITA host and Canvas clocks. The window is ±300 seconds; do not enlarge it to mask clock errors.                                                                                                                                                                              |
| Replayed launch / reloading POST                         | Launch afresh from Canvas for a new nonce. Do not resubmit a captured form or clear the nonce table. Nonces survive API restarts until the freshness window ends.                                                                                                                              |
| `503 SERVICE_UNAVAILABLE`                                | Initialize the local Owner credential. Check the API process's optional config path, private parent/file permissions (0700/0600), ownership, JSON schema, enabled state and secret lengths. Missing/disabled config does not fall back to unsigned access.                                     |
| `401 UNAUTHENTICATED` after prior success                | Session expired, API restarted, credential/config rotated/disabled, or another tab changed role. Re-launch from Canvas or sign in standalone.                                                                                                                                                  |
| `429 RATE_LIMITED`                                       | Wait a minute. Login has 20 attempts/minute and one outstanding password derivation; Canvas has 120 launch attempts/minute. Use an independently protected Owner entry.                                                                                                                        |
| Empty/denied History                                     | Check current role and Canvas context. Student/Teacher cannot read another role's records; Canvas sees only its configured context. Admin can inspect older retained records.                                                                                                                  |
| No new tab / certificate / browser private-network block | Trust only your own local HTTPS CA, confirm new-window App configuration and browser/institution policy. Use standalone while resolving the environment; never disable TLS, Origin checks or framing/cookie protections.                                                                       |

Deterministic launch and Page workflow tests use synthetic state. Preview, explicit creation and readback have synthetic desktop and mobile browser coverage. Real Canvas installation/substitution/origin/new-window behavior and real browser-to-loopback/private-network behavior require Owner checks and are **NOT_RUN** unless explicitly recorded for this Public revision. The Owner-authorized sandbox demo is documented in [media provenance](SCREENSHOTS.md); it does not establish interoperability for every environment. Do not publish captures from a private deployment.
