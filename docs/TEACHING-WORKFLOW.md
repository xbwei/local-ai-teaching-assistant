# Standalone Teacher tools

Complete the [public setup](GETTING-STARTED.md), use an operator-owned Local model and sign in as Teacher using your Owner passphrase. Both tools use the standalone local Teacher session.

## Local teaching drafts

Open **Local teaching drafts**, choose IA340 or IA342, and select **Lesson page** or **Assignment instructions**. Enter a focused teaching topic, such as “Lab 5 practice prompts” for IA342. Choose **Generate with Local**. Review the source paths and sections, read the generated instructions against the published course material, and edit the Markdown before copying it into your own material.

Only the [supported course sources](COURSE-GROUNDING.md) supply grounding. The input limit is 512 UTF-8 bytes. Use one course and one specific lab or numbered week for assignment or week references. If sources are unavailable, ambiguous or insufficient, clarify the topic or refresh the supported course snapshot. Drafting uses the API's selected Local model and shares the existing generation, time and accounting limits. If Local is busy or unavailable, wait for the current operation to finish or check the model setup.

Drafting returns editable text in the browser. It performs no external writes and creates no Chat History turn. Edits are discarded when navigating away. Copy any draft you want to keep. Check model output for accuracy before use.

## Test Student History

Enable the separate [History Chat plugin](HISTORY.md#teacher-history-plugin) for a sample of your own authored, non-sensitive practice questions. Use the ordinary Student role without the sample option for questions you want kept outside the sample.
