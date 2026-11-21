# Canvas GitHub assignment verification

Use this optional tool in an authorized practice course with non-sensitive submissions. The tool observes configured GitHub repository metadata for one current Canvas submission at a time. The Teacher makes grading and feedback decisions separately. These checks establish evidence about the selected resource at the time of the check. They do not demonstrate student authorship or execute submitted code.

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
    }
  ]
}
```

Use your own approved practice targets and every authorized student to be checked. Each configured assignment/provider entry requires 1–40 unique Canvas student IDs. Up to four entries fit within the 64 KiB file limit. A demo class of 30 uses 30 entries in the selected assignment’s `students` array. A student absent from the configuration is outside the scope. The tool checks active enrollment through an exact filtered Canvas read and retrieves that one individual submission. It does not enumerate other course users or follow pagination links. Use numeric Canvas and GitHub identifiers as strings without leading zeroes.

Only published individual, non-quiz assignments with visible, non-excused submissions that use Text Entry or Website URL are supported. Anonymous or moderated grading and uploaded files are outside this flow. Assignment and attempt metadata are rechecked. Source or authority changes withhold results.

## GitHub practice assignment

Use an expiring GitHub token for the exact configured reader identity with read-only Metadata and Contents access to the approved repositories. If inspecting a pull request, grant read-only Pull requests access as well. Confirm the minimum required scopes for your own token type and account. Approve one assigned private practice repository and one GitHub account per student, with the numeric IDs and canonical names. Use up to four distinct paths. Use `null` for `pullRequest` or configure its exact numeric `number` and `head` branch in that repository. It must target the approved `ref` from the configured account.

The submission supplies one matching GitHub profile or exact repository URL. LAITA matches it to the protected mapping and reads the fixed GitHub API to check the account and repository IDs, approved branch and path metadata. It verifies optional pull request state against the configured repository, branch and author ID. Output shows path results in configured order, then the pull request observation. It does not fetch file contents or execute repository content. [GitHub Git Trees API](https://docs.github.com/en/rest/git/trees)

## Run and read the results

Open **Verify Canvas submissions** in the signed Teacher view, select a configured assignment, and choose **Verify configured students**. The browser checks one student at a time. Each row is bounded to 40 seconds and the queue has a 15-minute limit. It shows one row per configured student, including unknown and unchecked results. **Cancel verification** stops the current request and marks the remaining rows cancelled. A browser reload clears the displayed results. The application stores no results or credentials from a submission.

**Observed** describes the recorded checks for the displayed attempt. A file can be absent in an observed result. **Partial** indicates an incomplete or unavailable provider observation. **Unknown** includes missing submissions, unavailable data and changed attempts. Review the actual authorized source where a result is partial or unknown. A changed or expired session, scope error or rate limit stops the queue and marks unresolved rows unchecked. Live provider acceptance is separate from synthetic testing.

Unset `LAITA_CANVAS_VERIFICATION_FILE` and restart the API to disable the tool. This change does not add a database migration. The protected verification file remains outside the checkout and can be removed from your operator setup separately.
