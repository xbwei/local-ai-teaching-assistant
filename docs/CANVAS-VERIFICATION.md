# Canvas assignment verification

Use this optional tool in an authorized practice course with non-sensitive submissions. The tool observes configured GitHub repository metadata or bounded MongoDB aggregates for one current Canvas submission at a time. The Teacher makes grading and feedback decisions separately. These checks establish evidence about the selected resource at the time of the check. They do not demonstrate student authorship or execute submitted code.

## Configure one course

Follow the [signed Teacher launch and REST setup](CANVAS.md#5-set-up-optional-canvas-rest-authoring). The REST token must identify the signed Teacher, with permission to read the course, active student enrollment, assignment and individual submissions. Use active **StudentEnrollment** IDs in the configured course. The Test Student scope used by the other Canvas tools remains separate.

Create a private JSON file with the same owner-only directory/file permissions as the Canvas REST file. Export only its path as `LAITA_CANVAS_VERIFICATION_FILE` in the foreground API environment. The API reads the file before use and rejects unknown fields or ambiguous scope. Enter your own values inside the protected file. Fill the example's GitHub token placeholder only in that file.

```json
{
  "origin": "https://canvas.example.test",
  "courseId": "42001",
  "teacherId": "73001",
  "github": {
    "token": "<your read-only GitHub token>",
    "expiresAt": "YYYY-MM-DDTHH:mm:ssZ"
  },
  "assignments": [
    {
      "provider": "GITHUB",
      "assignmentId": "91",
      "readerGitHubId": "77",
      "ref": "main",
      "paths": ["README.md"],
      "students": [
        {
          "id": "74001",
          "githubId": "75001",
          "githubLogin": "practice-example",
          "repository": "practice-example/sample-work",
          "repositoryId": "76001",
          "pullRequest": null
        }
      ]
    },
    {
      "provider": "MONGODB",
      "assignmentId": "92",
      "collections": [
        {
          "name": "items",
          "fields": [{ "path": "label", "type": "string", "nonempty": true }]
        }
      ],
      "students": [
        { "id": "74001", "host": "practice.example.mongodb.net", "database": "practice" }
      ]
    }
  ]
}
```

Use your own approved practice targets and every authorized student to be checked. Each configured assignment/provider entry requires 1–40 unique Canvas student IDs. Up to four entries fit within the 64 KiB file limit. A demo class of 30 uses 30 entries in the selected assignment’s `students` array. A student absent from the configuration is outside the scope. The tool checks active enrollment through an exact filtered Canvas read and retrieves that one individual submission. It does not enumerate other course users or follow pagination links. Use numeric Canvas and GitHub identifiers as strings without leading zeroes. Use `"github": null` if you only configure MongoDB.

Only published individual, non-quiz assignments with visible, non-excused submissions that use Text Entry or Website URL are supported. Anonymous or moderated grading and uploaded files are outside this flow. Assignment and attempt metadata are rechecked. Source or authority changes withhold results.

## GitHub practice assignment

Use an expiring GitHub token for the exact configured reader identity with read-only Metadata and Contents access to the approved repositories. If inspecting a pull request, grant read-only Pull requests access as well. Confirm the minimum required scopes for your own token type and account. Approve one assigned private practice repository and one GitHub account per student, with the numeric IDs and canonical names. Use up to four distinct paths. Use `null` for `pullRequest` or configure its exact numeric `number` and `head` branch in that repository. It must target the approved `ref` from the configured account.

The submission supplies one matching GitHub profile or exact repository URL. LAITA matches it to the protected mapping and reads the fixed GitHub API to check the account and repository IDs, approved branch and path metadata. It verifies optional pull request state against the configured repository, branch and author ID. Output shows path results in configured order, then the pull request observation. It does not fetch file contents or execute repository content. [GitHub Git Trees API](https://docs.github.com/en/rest/git/trees)

## MongoDB practice assignment

Use a disposable practice database with a short-lived, unique account limited to read access to the approved database. Submit the connection URI only through the authorized Canvas practice assignment. Keep the course and submissions access-controlled, remove practice credentials from Canvas when no longer needed, and revoke or rotate them after use. Never use a production account or a reused password. LAITA processes the exact submission’s URI in request memory. It passes only the validated user/password to an isolated driver worker against the trusted configured seed and approved database. LAITA does not retain or display the URI, credentials, host, database, collection names, field paths or document values in verification outcomes, logs or History. The provider does not receive other course data.

Use an Atlas replica set hostname under `mongodb.net` and simple database, collection and field names. Submit one `mongodb+srv://` URI for the exact configured host and database. A single-host `mongodb://` URI for the same target is accepted as input, and the worker still uses Atlas SRV, public IPv4 and verified TLS. The driver uses the operator-approved target and fixed options and runs only fixed metadata and aggregate checks. Configure at most two collections with up to four named fields each. Output lists each collection observation and its field observations in configured order. Counts are bounded at 1,001 documents and field summaries check at most 101 documents per field. Reaching a cap yields **Partial** even when the sampled values match. A successful connection does not establish authorship. Source and target rechecks and provider reads occur in separate requests, so they cannot make the observation atomic. [MongoDB connection string formats](https://www.mongodb.com/docs/manual/reference/connection-string-formats/)

## Run and read the results

Open **Verify Canvas submissions** in the signed Teacher view, select a configured provider and assignment, and choose **Verify configured students**. The browser checks one student at a time. Each row is bounded to 40 seconds and the queue has a 15-minute limit. It shows one row per configured student, including unknown and unchecked results. **Cancel verification** stops the current request and marks the remaining rows cancelled. A browser reload clears the displayed results. The application stores no results or credentials from a submission.

**Observed** describes the recorded checks for the displayed attempt. A file or collection can be absent in an observed result. **Partial** indicates a bounded sample or an incomplete provider response. **Unknown** includes missing submissions, unavailable data and changed attempts. Review the actual authorized source where a result is partial or unknown. A changed or expired session, scope error or rate limit stops the queue and marks unresolved rows unchecked. Live provider acceptance is separate from synthetic testing.

Unset `LAITA_CANVAS_VERIFICATION_FILE` and restart the API to disable the tool. This change does not add a database migration. The protected verification file remains outside the checkout and can be removed from your operator setup separately.
