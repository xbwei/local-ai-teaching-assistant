# Standalone Teacher tools

Complete the [public setup](GETTING-STARTED.md), use an operator-owned Local model and sign in as Teacher using your Owner passphrase. Both tools use the standalone local Teacher session.

## Local teaching drafts

Open **Local teaching drafts**, choose IA340 or IA342, and select **Lesson page** or **Assignment instructions**. Enter a focused teaching topic, such as “Lab 5 practice prompts” for IA342. Choose **Generate with Local**. Review the source paths and sections, read the generated instructions against the published course material, and edit the Markdown before copying it into your own material.

Only the [supported course sources](COURSE-GROUNDING.md) supply grounding. The input limit is 512 UTF-8 bytes. Use one course and one specific lab or numbered week for assignment or week references. If sources are unavailable, ambiguous or insufficient, clarify the topic or refresh the supported course snapshot. Drafting uses the API's selected Local model and shares the existing generation, time and accounting limits. If Local is busy or unavailable, wait for the current operation to finish or check the model setup.

Drafting returns editable text in the browser. It performs no external writes and creates no Chat History turn. Edits are discarded when navigating away. Copy any draft you want to keep. Check model output for accuracy before use.

## Test Student History

Enable the separate [History Chat plugin](HISTORY.md#teacher-history-plugin) for a sample of your own authored, non-sensitive practice questions. Use the ordinary Student role without the sample option for questions you want kept outside the sample.

## Use edited Markdown in Canvas

Copy reviewed, non-sensitive Markdown from the standalone draft. Open your separate signed Canvas Teacher session, enter a title and paste the Markdown. Review the exact destination and content before choosing **Create unpublished page**. The Canvas Page editor uses separate, optional REST setup. [Canvas Page walkthrough](CANVAS.md#6-preview-and-create-a-page)

For an assignment draft, use **Canvas Assignments** in the signed Canvas Teacher view. The operator can preview an unpublished assignment in the configured group or preview a title-only change to an approved assignment. [Canvas Assignment walkthrough](CANVAS.md#7-create-and-rename-canvas-assignments)

Use **Canvas Modules** to preview an empty unpublished module or add one approved Page or Assignment to an approved unpublished module. Confirm each change in its own preview and check the readback result. [Canvas Module walkthrough](CANVAS.md#8-create-and-organize-unpublished-canvas-modules)

In the same signed Teacher view, open the optional **Canvas Chat plugin** and ask “How many submissions for Map studio?” or “What is the score for Map studio?” using the full title of one approved practice assignment. This answers from one Canvas Test Student sample. [Setup and scope](CANVAS.md#canvas-chat-plugin)

Use **Canvas Test Student feedback** to review the exact assignment, recipient, attempt and text before choosing **Post feedback**. Check the readback. If it is uncertain or unverified, check Canvas directly before trying again. A feedback comment does not update a grade. [Feedback setup and walkthrough](CANVAS.md#canvas-teacher-feedback)

Open **Verify Canvas submissions** to check a configured practice assignment. Rows are keyed by Canvas student ID and show the current attempt and bounded observations. Review unavailable and partial rows in Canvas or the authorized provider before relying on them. [Assignment verification setup and limits](CANVAS-VERIFICATION.md)
