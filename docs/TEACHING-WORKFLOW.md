# Teacher tools and optional Canvas workflows

Complete [Getting Started](GETTING-STARTED.md), configure a Local model, and sign in using the **separate Demo Teacher** passphrase for an actively granted course. Owner Admin and Demo Student use their own passphrases. Optional Canvas authoring uses a signed Instructor launch and a *separate REST token*.

## Local teaching drafts

Open **Local teaching drafts**, choose IA340 or IA342, and select **Lesson page** or **Assignment instructions**. Enter a focused teaching topic, such as “Lab 5 practice prompts” for IA342. Choose **Generate with Local**. Review the source paths and sections, read the generated instructions against the published course material, and edit the Markdown before copying it into your own material.

Only the [supported course sources](COURSE-GROUNDING.md) supply grounding. The input limit is 512 UTF-8 bytes. Use one course and one specific lab or numbered week for assignment or week references. If sources are unavailable, ambiguous or insufficient, clarify the topic or refresh the supported course snapshot. Drafting uses the API's selected Local model and shares the existing generation, time and accounting limits. If Local is busy or unavailable, wait for the current operation to finish or check the model setup.

Drafting returns editable text in the browser. It performs no external writes and creates no Chat History turn. Edits are discarded when navigating away. Copy any draft you want to keep. Check model output for accuracy before use.

## Test Student History

Use [course-scoped History Chat](HISTORY.md#teacher-history-plugin) for real non-sensitive questions asked by the authorized Demo Student in the currently selected course. A new installation legitimately starts at zero; no seeded fake questions are required.

## Use editable Local suggestions in Canvas

The Teacher may generate a grounded Page/Assignment suggestion in the appropriate signed Canvas Teacher flow; examine the source excerpt/path and edit the text before applying it. The model does not choose Canvas destinations or dispatch external writes. Continue through a **fresh Preview → Confirm → Readback**.

For an Assignment, refresh the actual current-course Assignment Groups and choose one yourself. Create the Assignment and a Page **Unpublished**. Independently create a named **Unpublished Module**; refresh saved Pages/Assignments/Modules and select the just-created items in the desired order. With `"modules": { "organizeSavedResources": true }` configured **once** in the protected Canvas REST settings, **no manual copying of resource IDs into JSON is needed**. Module destination remains Unpublished; teachers can publish the results later directly in Canvas. [Exact workflow](CANVAS.md#8-create-and-organize-unpublished-canvas-modules).

If an external write is uncertain, inspect the Canvas course before any retry.

In the same signed Teacher view, choose **Ask about → Canvas (Local)** to use an available tool-capable Local model for selecting a bounded count/score lookup, or **Canvas (Direct)** for an exact query such as “How many submissions for Map studio?” or “What is the score for Map studio?” Use the full, unambiguous title of one approved practice assignment. Local selection never silently falls back to Direct; select Direct explicitly if the Local model cannot choose a tool. Both routes format the bounded Canvas observation deterministically for **one configured Test Student**, not an entire class. [Setup and scope](CANVAS.md#canvas-chat-plugin)

Use **Canvas Test Student feedback** to review the exact assignment, recipient, attempt and text before choosing **Post feedback**. Check the readback. If it is uncertain or unverified, check Canvas directly before trying again. A feedback comment does not update a grade. [Feedback setup and walkthrough](CANVAS.md#canvas-teacher-feedback)

Open **Verify Canvas submissions** to check a configured practice assignment. Rows are keyed by Canvas student ID and show the current attempt and bounded observations. Review unavailable and partial rows in Canvas or the authorized provider before relying on them. [Assignment verification setup and limits](CANVAS-VERIFICATION.md)
