import { initializeRuntimePaths } from "@laita/runtime";
import { initializePersistence } from "@laita/persistence";
/** Opt-in real browser + local HTTPS + fake providers only.
 * PLAYWRIGHT_MODULE=/absolute/playwright/index.mjs node scripts/test-browser-client.mjs
 * Requires installed Chrome/openssl; never downloads or uses real providers,
 * microphone hardware or system TTS. Speech/audio are synthetic fixtures.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { fixture } from "../apps/api/test/browser-fixture.mjs";
import { canvas, canvasNow, canvasPageFixture, signed } from "../apps/api/test/canvas-fixture.mjs";
import { canvasVerificationFixture } from "../apps/api/test/canvas-verification-fixture.mjs";
import { wav } from "../apps/web/src/client/microphone.ts";
const { chromium } = await import(
  pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
);
const root = mkdtempSync(path.join(tmpdir(), "browser-https-fixture-"));
let f, browser, persistence;
let speechState = "READY";
const markdownAnswer =
  '### Synthetic heading\n\n**Bold** and *italic* with `code`.\n\n- First\n- Second\n\n1. Numbered\n2. Next\n\n```js\nconst x = "<script>";\n```\n\n<script>window.modelExecuted = true</script>\n<img src="https://example.invalid/track" onerror="window.modelExecuted = true">\n\n[unsafe](javascript:alert(1)) ![image](https://example.invalid/image)';
const longEnglishAnswer = Array.from(
  { length: 24 },
  (_, index) =>
    `Paragraph ${index + 1} explains a synthetic idea with enough detail to exercise complete long-answer reading on a compact display.`,
).join("\n\n");
const longChineseAnswer = Array.from(
  { length: 24 },
  (_, index) =>
    `第${index + 1}段用合成内容说明一个概念，并保留足够的文字来验证小屏幕上的完整长回答阅读。`,
).join("\n\n");
const courseQuestion =
  "What must students submit for IA342's fifth assignment?";
const courseCommit = "b".repeat(40);
const coursePath = "docs/assignments/lab-5/index.md";
const courseSection = "Deliverables";
const courseUrl = `https://github.com/JMU-Data/IA342/blob/${courseCommit}/${coursePath}#deliverables`;
const courseExcerpt = Array.from(
  { length: 9 },
  (_, index) =>
    `Evidence line ${index + 1}: build the named worksheets and dashboard, then verify the published requirement.`,
).join("\n");
assert.ok(Buffer.byteLength(courseExcerpt) <= 900);
try {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      path.join(root, "key.pem"),
      "-out",
      path.join(root, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  const audioPath = path.join(root, "synthetic.wav");
  writeFileSync(
    audioPath,
    wav(
      Int16Array.from(
        { length: 32000 },
        (_, i) => Math.sin((i * 2 * Math.PI * 440) / 16000) * 4000,
      ),
    ),
  );
  const webRoot = path.join(root, "web");
  cpSync(fileURLToPath(new URL("../apps/web/dist", import.meta.url)), webRoot, {
    recursive: true,
  });
  const runtime = initializeRuntimePaths(path.join(root, "runtime"));
  assert.equal(runtime.ok, true);
  const initialized = initializePersistence(runtime.value);
  assert.equal(initialized.ok, true);
  persistence = initialized.value;
  const seededHistory = persistence.history();
  const diagnosticReference = randomUUID();
  for (let i = 0; i < 65; i++) {
    const id = (i + 1).toString(16).padStart(64, "0");
    seededHistory.begin({
      id,
      conversation: id,
      inputType: i % 2 ? "VOICE" : "TYPED",
      text: `Scan fixture ${i} ${"compact preview ".repeat(30)}`,
      correlation: i === 0 ? diagnosticReference : null,
    });
    seededHistory.result(
      id,
      `scan-${i}`,
      [
        {
          leg: `scan-${i}`,
          provider: "LOCAL",
          model: "synthetic-summary",
          actualProvider: "LOCAL",
          actualModel: "synthetic-summary",
          status: "COMPLETED",
          text: "DETAIL_ONLY_ANSWER_189".repeat(100),
          failure: null,
          latencyMs: 1,
        },
      ],
      "SUCCESS",
    );
    if (i === 0)
      seededHistory.event(id, {
        stage: "TTS",
        outcome: "FAILED",
        origin: "SERVER",
        at: new Date().toISOString(),
      });
    if ([0, 3, 4, 5].includes(i))
      seededHistory.review(id, id, {
        review: i === 3 ? "CONFIRMED_ISSUE" : i === 4 ? "REVIEWED" : "NO_ISSUE",
        note: "Synthetic optional annotation",
        suspected: false,
        suspicionReason: "",
      });
    if (i === 1)
      seededHistory.feedback(id, id, {
        leg: `scan-${i}`,
        vote: "NOT_HELPFUL",
        report: false,
        reason: "Synthetic dislike",
      });
    if (i === 2)
      seededHistory.feedback(id, id, {
        leg: `scan-${i}`,
        vote: null,
        report: true,
        reason: "Synthetic report",
      });
  }
  seededHistory.begin({
    id: "e".repeat(64),
    conversation: "d".repeat(64),
    inputType: "TYPED",
    text: "Missing snapshot fixture",
    correlation: null,
  });
  seededHistory.event("e".repeat(64), {
    stage: "SNAPSHOT",
    outcome: "LOADED",
    origin: "SERVER",
    at: new Date().toISOString(),
    snapshot: { course: "IA340", commit: "c".repeat(40) },
  });
  seededHistory.outcome("e".repeat(64), "NO_ANSWER");
  const sampleContext = "5".repeat(64);
  const syntheticCanvas = canvasPageFixture({ assignments: true, modules: true, chat: true, feedback: true });
  const syntheticVerification = canvasVerificationFixture(syntheticCanvas);
  syntheticVerification.options.selectChatTool = async (question) => {
    const assignment = syntheticCanvas.assignmentRows.get("81").name;
    if (question === `Tell me the submission tally for ${assignment}.`)
      return { name: "canvas_submission_count", arguments: { assignment } };
    if (question === `For ${assignment}, what score was recorded?`)
      return { name: "canvas_assignment_score", arguments: { assignment } };
    return null;
  };
  f = await fixture({
    history: persistence.history(),
    persistence,
    canvas: () => canvas,
    authNow: () => canvasNow,
    canvasPages: syntheticVerification.options,
    teacherDraft: async (course, kind, topic) => {
      assert.equal(course, "IA342");
      assert.equal(kind, "ASSIGNMENT");
      assert.equal(topic, "Lab 5");
      return {
        mode: "LOCAL",
        grounding: { status: "GROUNDED", course: "IA342", sources: [{ course: "IA342", path: "docs/example.md", section: "Lab 5" }] },
        legs: [{ provider: "LOCAL", provenance: { actualProvider: "LOCAL" }, status: "COMPLETED", output: { text: "## Practice task\nCompare two visual explanations." } }],
      };
    },
    teacherHistory: {
      context: sampleContext,
      read: () => persistence.history({ role: "student", context: sampleContext }),
      async select(question) {
        if (question === "Can you tally the past seven days of questions?")
          return { name: "history_count", arguments: { window: "recent" } };
        if (question === "Which themes appeared in the sample recently?")
          return { name: "history_summary", arguments: { window: "recent" } };
        return null;
      },
      async summarize(questions) {
        assert.deepEqual(JSON.parse(questions), ["How can I compare two visual explanations?"]);
        return "The sample asks about comparing visual explanations.";
      },
    },
    answerText: (request) =>
      request.input.text === "Show a long English answer."
        ? longEnglishAnswer
        : request.input.text === "请显示一段较长的中文回答。"
          ? longChineseAnswer
          : request.input.text === courseQuestion
            ? "Build the named worksheets and dashboard from the published IA342 instructions."
            : markdownAnswer,
    grounding: (request) =>
      request.mode === "LOCAL" && request.input.text === courseQuestion
        ? {
            status: "GROUNDED",
            course: "IA342",
            snapshot: courseCommit,
            sources: [
              {
                course: "IA342",
                repository: "JMU-Data/IA342",
                commit: courseCommit,
                path: coursePath,
                section: courseSection,
                url: courseUrl,
                excerpt: courseExcerpt,
              },
            ],
          }
        : undefined,
    speechState: () => speechState,
    tls: {
      key: readFileSync(path.join(root, "key.pem")),
      cert: readFileSync(path.join(root, "cert.pem")),
    },
    webRoot,
  });
  browser = await chromium.launch({
    ...(process.env.CLIENT_CHROMIUM_BINARY
      ? { executablePath: process.env.CLIENT_CHROMIUM_BINARY }
      : { channel: "chrome" }),
    headless: true,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${audioPath}`,
    ],
  });
  const results = [];
  const { testPassphrase } = await import("../apps/api/test/owner-fixture.mjs");
  for (const { name, width, height, mobile } of [
    { name: "teacher-desktop", width: 1280, height: 800, mobile: false },
    { name: "teacher-phone", width: 390, height: 844, mobile: true },
  ]) {
    const context = await browser.newContext({
      viewport: { width, height },
      isMobile: mobile,
      hasTouch: mobile,
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    const requests = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.goto(f.origin);
    const signIn = async (role, sample = false) => {
      await page.locator('[name="role"]').selectOption(role);
      if (sample) await page.getByLabel("Test Student sample (if configured)").check();
      await page.locator('[name="passphrase"]').fill(testPassphrase);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.locator(".owner-role").waitFor();
    };
    await signIn("student", true);
    assert.match(await page.locator(".owner-role").innerText(), /Test Student sample/);
    assert.equal(await page.getByLabel("Ask about").isVisible(), false);
    if (!mobile) {
      await page.locator("#question:not([disabled])").fill("How can I compare two visual explanations?");
      await page.locator("#composer").getByRole("button", { name: "Send", exact: true }).click();
      await page.locator("#messages article.answer").first().waitFor();
    }
    await page.goto(`${f.origin}/history`);
    await page.getByRole("heading", { name: "Owner history & review" }).waitFor();
    assert.equal(await page.getByText("Find a local diagnostic", { exact: true }).count(), 0);
    await page.getByRole("button", { name: "Sign out / change role" }).click();
    await signIn("teacher");
    assert.equal(await page.getByText("Create a Canvas Page", { exact: true }).isVisible(), false);
    assert.equal(await page.getByText("Canvas Assignments", { exact: true }).isVisible(), false);
    await page.getByText("Local teaching drafts", { exact: true }).click();
    await page.getByLabel("Course", { exact: true }).selectOption("IA342");
    await page.getByLabel("Draft type").selectOption("ASSIGNMENT");
    await page.getByLabel("Topic", { exact: true }).fill("Lab 5");
    await page.getByRole("button", { name: "Generate with Local" }).click();
    await page.getByText("Draft ready. Check the sources and edit before use.").waitFor();
    const draft = page.getByLabel("Editable Markdown draft");
    assert.match(await draft.inputValue(), /Compare two visual explanations/);
    await page.getByText("docs/example.md · Lab 5", { exact: true }).waitFor();
    await draft.fill("Teacher revision");
    assert.equal(await draft.inputValue(), "Teacher revision");
    const askAbout = page.getByLabel("Ask about");
    const historyQuestion = page.getByLabel("Your question");
    const ask = page.locator("#composer").getByRole("button", { name: "Send", exact: true });
    const toolAnswer = page.locator("#conversation #teacher-chat-answer");
    await askAbout.waitFor();
    assert.deepEqual(await askAbout.locator("option").allTextContents(), ["General chat", "History (Local)"]);
    assert.equal(await askAbout.inputValue(), "conversation");
    await askAbout.selectOption("history");
    assert.equal(await historyQuestion.getAttribute("maxlength"), "200");
    assert.equal(await page.getByRole("button", { name: "Mic" }).isVisible(), false);
    assert.equal(await page.locator("#providers").isVisible(), false);
    const historyRequests = requests.length;
    await historyQuestion.fill("Can you tally the past seven days of questions?");
    await ask.click();
    await toolAnswer.getByText(/^1 question recorded for the Test Student sample/).waitFor();
    await historyQuestion.fill("Which themes appeared in the sample recently?");
    await ask.click();
    await toolAnswer.getByText("The sample asks about comparing visual explanations.", { exact: true }).waitFor();
    assert.deepEqual(requests.slice(historyRequests), Array(2).fill(f.origin + "/api/v1/teacher-tools/history"));
    assert.equal(await page.locator("#messages article").count(), 0);
    if (!mobile) {
      const late = Promise.withResolvers();
      const completed = Promise.withResolvers();
      await page.route("**/api/v1/teacher-tools/history", async (route) => {
        await late.promise;
        await route.fulfill({ json: { text: "Late synthetic History answer" } }).catch(() => {});
        completed.resolve();
      }, { times: 1 });
      const started = page.waitForRequest(request => request.url().endsWith("/api/v1/teacher-tools/history") && request.method() === "POST");
      await historyQuestion.fill("Are there recent questions?");
      await ask.click();
      await started;
      assert.equal(await askAbout.isDisabled(), true);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await toolAnswer.getByText("Cancelled.", { exact: true }).waitFor();
      late.resolve();
      await completed.promise;
      assert.equal(await toolAnswer.textContent(), "Cancelled.");
    }
    await historyQuestion.fill("An unsent sample query");
    await askAbout.selectOption("conversation");
    assert.equal(await historyQuestion.inputValue(), "");
    assert.equal(await toolAnswer.textContent(), "");
    assert.equal(await page.locator("#providers").isVisible(), true);
    assert.equal(await historyQuestion.getAttribute("maxlength"), "2000");
    const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(pageWidth <= width, `${name} layout overflowed its viewport`);
    assert.ok(requests.every((request) => new URL(request).origin === f.origin));
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    assert.equal(await draft.inputValue(), "");
    assert.equal(await historyQuestion.inputValue(), "");
    await page.goto(`${f.origin}/history`);
    await page.getByRole("heading", { name: "Owner history & review" }).waitFor();
    assert.equal(await page.getByText("Find a local diagnostic", { exact: true }).count(), 0);
    results.push({ name, width, height, status: "PASS", requests: requests.length });
    await context.close();
  }
  for (const { name, width, height, mobile } of [
    { name: "canvas-page-desktop", width: 1280, height: 800, mobile: false },
    { name: "canvas-page-phone", width: 390, height: 844, mobile: true },
  ]) {
    const context = await browser.newContext({
      viewport: { width, height },
      isMobile: mobile,
      hasTouch: mobile,
      ignoreHTTPSErrors: true,
    });
    const launchPath = "/api/v1/canvas/launch";
    const launch = await f.request(launchPath, {
      method: "POST",
      headers: {
        origin: canvas.canvasOrigin,
        "sec-fetch-site": "cross-site",
        "content-type": "application/x-www-form-urlencoded",
        cookie: "",
      },
      body: signed(f.config.publicOrigin + launchPath, { oauth_nonce: name }),
    });
    assert.equal(launch.status, 303);
    const cookie = launch.headers.get("set-cookie").split(";")[0];
    const split = cookie.indexOf("=");
    await context.addCookies([{
      name: cookie.slice(0, split),
      value: cookie.slice(split + 1),
      url: f.origin + "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    }]);
    const page = await context.newPage();
    const requests = [];
    page.on("request", (request) => requests.push(request.url()));
    const writes = syntheticCanvas.writes.length;
    await page.goto(f.origin);
    await page.getByText("Create a Canvas Page", { exact: true }).click();
    assert.equal(await page.getByText("Local teaching drafts", { exact: true }).isVisible(), false);
    const title = page.getByLabel("Page title");
    const markdown = page.getByLabel("Page Markdown");
    const preview = page.getByRole("region", { name: "Canvas Page preview" });
    const previewButton = page.getByRole("button", { name: "Preview Canvas Page" });
    const create = page.getByRole("button", { name: "Create unpublished page" });
    await title.fill("Field exercise — 地图 🌍");
    await markdown.fill("# Compare routes\n\nPlot a **synthetic** map. 地图 🌍");
    assert.equal(await create.isVisible(), false);
    await previewButton.click();
    await preview.getByText(/^Synthetic Studio/).waitFor();
    assert.match(await preview.locator("#canvas-page-target").textContent(), /Course 42001.*Teacher 73001.*canvas.example.test/);
    await preview.getByRole("heading", { name: "Field exercise — 地图 🌍" }).waitFor();
    await preview.getByRole("heading", { name: "Compare routes" }).waitFor();
    await preview.getByText("Exact HTML sent to Canvas").click();
    assert.equal(await preview.locator("pre").textContent(), "<h2>Compare routes</h2><p>Plot a <strong>synthetic</strong> map. 地图 🌍</p>");
    assert.equal(syntheticCanvas.writes.length, writes);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width);
    await markdown.fill("Revised teaching content — 安全 🌍");
    assert.equal(await create.isVisible(), false);
    await previewButton.click();
    await preview.getByText("Revised teaching content — 安全 🌍", { exact: true }).waitFor();
    assert.equal(syntheticCanvas.writes.length, writes);
    await create.click();
    await page.getByText("Canvas verified unpublished Page 9001.").waitFor();
    assert.equal(syntheticCanvas.writes.length, writes + 1);
    assert.equal(syntheticCanvas.writes.at(-1)["wiki_page[body]"], "<p>Revised teaching content — 安全 🌍</p>");
    assert.equal(await create.isVisible(), false);
    assert.ok(requests.every((request) => new URL(request).origin === f.origin));
    assert.equal(requests.filter((request) => request.endsWith("/api/v1/canvas/pages/create")).length, 1);
    assert.doesNotMatch(await page.locator("body").innerText(), /synthetic-rest-token/);
    results.push({ name, width, height, status: "PASS", requests: requests.length });

    await page.getByText("Create a Canvas Page", { exact: true }).click();
    await page.getByText("Canvas Assignments", { exact: true }).click();
    const tool = page.locator("#teacher-canvas-assignments");
    const assignmentPreview = tool.getByRole("region", { name: "Canvas Assignment preview" });
    const assignmentTitle = tool.getByLabel("Assignment title");
    const previewAssignment = tool.getByRole("button", { name: "Preview Canvas Assignment" });
    const createAssignment = assignmentPreview.getByRole("button", { name: "Create unpublished assignment" });
    const saveTitle = assignmentPreview.getByRole("button", { name: "Save assignment title" });
    const assignmentWrites = syntheticCanvas.assignmentWrites.length;
    await assignmentTitle.fill("Synthetic studio lab");
    await tool.getByLabel("Assignment Markdown").fill("## Map lab\n\nCompare two maps. 地图");
    await tool.getByLabel("Points possible").fill("4.5");
    await tool.getByLabel("File Upload").check();
    await tool.getByLabel("Due date and time (UTC, optional)").fill("2026-12-21T10:30");
    await previewAssignment.click();
    await assignmentPreview.getByText(/^Group 72 · Studio Exercises/).waitFor();
    assert.match(await assignmentPreview.locator("#canvas-assignment-subject").textContent(), /Unpublished.*4.5 points.*Text Entry, File Upload.*2026-12-21T10:30:00.000Z/);
    await assignmentPreview.getByRole("heading", { name: "Map lab" }).waitFor();
    assert.equal(syntheticCanvas.assignmentWrites.length, assignmentWrites);
    await assignmentTitle.fill("Reviewed studio lab");
    assert.equal(await createAssignment.isVisible(), false);
    await previewAssignment.click();
    await assignmentPreview.getByRole("heading", { name: "Reviewed studio lab" }).waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width);
    await createAssignment.click();
    await tool.getByText("Canvas verified assignment 91.").waitFor();
    assert.equal(syntheticCanvas.assignmentWrites.length, assignmentWrites + 1);

    await tool.getByLabel("Assignment action").selectOption("TITLE");
    await tool.getByLabel("Assignment to rename").selectOption("81");
    assert.equal(await tool.getByLabel("Assignment Markdown").isVisible(), false);
    const previousTitle = syntheticCanvas.assignmentRows.get("81").name;
    const updatedTitle = mobile ? "Reviewed title on phone" : "Reviewed title on desktop";
    await assignmentTitle.fill(updatedTitle);
    await previewAssignment.click();
    await assignmentPreview.getByText(/^Assignment 81 · Current title/).waitFor();
    assert.ok((await assignmentPreview.locator("#canvas-assignment-subject").textContent()).includes(previousTitle));
    await assignmentPreview.getByRole("button", { name: "Cancel assignment preview" }).click();
    assert.equal(await saveTitle.isVisible(), false);
    assert.equal(syntheticCanvas.assignmentWrites.length, assignmentWrites + 1);
    await previewAssignment.click();
    await saveTitle.waitFor();
    syntheticCanvas.assignmentRows.get("81").updated_at = "2026-11-20T12:00:00.123456Z";
    await saveTitle.click();
    await tool.getByText("The preview could not be confirmed. Review the current assignment and preview again.").waitFor();
    assert.equal(syntheticCanvas.assignmentWrites.length, assignmentWrites + 1);
    await previewAssignment.click();
    await saveTitle.click();
    await tool.getByText("Canvas verified assignment 81.").waitFor();
    assert.equal(syntheticCanvas.assignmentRows.get("81").name, updatedTitle);
    assert.equal(syntheticCanvas.assignmentWrites.length, assignmentWrites + 2);
    assert.equal(requests.filter(request => request.endsWith("/api/v1/canvas/assignments/save")).length, 3);
    assert.ok(requests.every(request => new URL(request).origin === f.origin));
    results.push({ name: mobile ? "canvas-assignment-phone" : "canvas-assignment-desktop", width, height, status: "PASS", requests: requests.length });
    const moduleTool = page.locator("#teacher-canvas-modules");
    const modulePreview = moduleTool.getByRole("region", { name: "Canvas Module preview" });
    const previewModule = moduleTool.getByRole("button", { name: "Preview Canvas Module change" });
    syntheticCanvas.moduleRows.get("61").items.length = 0;
    const moduleWrites = syntheticCanvas.moduleWrites.length;
    await moduleTool.locator("summary").click();
    await moduleTool.getByLabel("Module title").fill("Maps 地图");
    await previewModule.click();
    await modulePreview.getByText(/Create an empty, unpublished module named/).waitFor();
    assert.match(await modulePreview.textContent(), /Course 42001.*Teacher 73001/s);
    assert.match(await modulePreview.textContent(), /Maps 地图/);
    assert.equal(syntheticCanvas.moduleWrites.length, moduleWrites);
    await modulePreview.getByRole("button", { name: "Create unpublished module" }).click();
    await moduleTool.getByText(/Canvas verified module 62/).waitFor();
    assert.equal(syntheticCanvas.moduleWrites.length, moduleWrites + 1);
    assert.equal(syntheticCanvas.moduleRows.get("62").published, false);

    const chooseModuleAction = moduleTool.getByLabel("Module action");
    const addItem = modulePreview.getByRole("button", { name: "Add item to module" });
    await chooseModuleAction.selectOption("LINK_PAGE");
    await moduleTool.getByLabel("Destination module").selectOption("61");
    await moduleTool.getByLabel("Item to add").selectOption("9002");
    await previewModule.click();
    await modulePreview.getByText(/Add Page 9002/).waitFor();
    assert.match(await modulePreview.textContent(), /Maps and examples.*unpublished Module 61/s);
    await modulePreview.getByRole("button", { name: "Cancel module preview" }).click();
    assert.equal(await modulePreview.isVisible(), false);
    assert.equal(syntheticCanvas.moduleWrites.length, moduleWrites + 1);
    await previewModule.click();
    await addItem.click();
    await moduleTool.getByText("Canvas verified module item 101.").waitFor();
    await chooseModuleAction.selectOption("LINK_ASSIGNMENT");
    await previewModule.click();
    await modulePreview.getByText(/Add Assignment 81/).waitFor();
    assert.equal(syntheticCanvas.moduleWrites.length, moduleWrites + 2);
    await addItem.click();
    await moduleTool.getByText("Canvas verified module item 102.").waitFor();
    assert.deepEqual(syntheticCanvas.moduleRows.get("61").items.map(item => item.type), ["Page", "Assignment"]);
    assert.equal(requests.filter(request => request.endsWith("/api/v1/canvas/modules/save")).length, 3);
    assert.ok(requests.every(request => new URL(request).origin === f.origin));
    results.push({ name: mobile ? "canvas-module-phone" : "canvas-module-desktop", width, height, status: "PASS", requests: requests.length });
    const canvasQuestion = page.getByLabel("Your question");
    const askCanvas = page.locator("#composer").getByRole("button", { name: "Send", exact: true });
    const canvasAnswer = page.locator("#conversation #teacher-chat-answer");
    const queryMode = page.getByLabel("Ask about");
    await queryMode.waitFor();
    assert.deepEqual(await queryMode.locator("option").allTextContents(), ["General chat", "Canvas (Local)", "Canvas (Direct)"]);
    assert.equal(await queryMode.inputValue(), "conversation");
    await queryMode.selectOption("canvas-local");
    assert.equal(await canvasQuestion.getAttribute("maxlength"), "280");
    assert.match(await page.locator("#teacher-chat-scope").textContent(), /configured Canvas Test Student/);
    const browserRequests = requests.length;
    const providerRequests = syntheticCanvas.calls.length;
    await canvasQuestion.fill(`Tell me the submission tally for ${updatedTitle}.`);
    await askCanvas.click();
    await canvasAnswer.getByText(/^1 submission.*configured Test Student/).waitFor();
    await canvasQuestion.fill(`For ${updatedTitle}, what score was recorded?`);
    await askCanvas.click();
    await canvasAnswer.getByText(/is 6\.5 of 7 points.*configured Test Student/).waitFor();
    await canvasQuestion.fill("What are the class grades?");
    await askCanvas.click();
    await canvasAnswer.getByText(/^Ask how many submissions or what score/).waitFor();
    await queryMode.selectOption("canvas-direct");
    assert.equal(await page.getByLabel("Local model", { exact: true }).isVisible(), false);
    await canvasQuestion.fill(`How many submissions for ${updatedTitle}?`);
    await askCanvas.click();
    await canvasAnswer.getByText(/^1 submission.*configured Test Student/).waitFor();
    assert.deepEqual(requests.slice(browserRequests), [
      ...Array(3).fill(f.origin + "/api/v1/canvas/chat/tools"),
      f.origin + "/api/v1/canvas/chat",
    ]);
    assert.ok(syntheticCanvas.calls.slice(providerRequests).every(([method]) => method === "GET"));
    assert.equal(await page.locator("#messages article").count(), 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width);
    results.push({ name: mobile ? "canvas-chat-phone" : "canvas-chat-desktop", width, height, status: "PASS", requests: requests.length });

    const feedback = page.locator("#teacher-canvas-feedback");
    const feedbackPreview = feedback.getByRole("region", { name: "Canvas feedback preview" });
    const feedbackText = feedback.getByLabel("Plain-text feedback", { exact: false });
    const previewFeedback = feedback.getByRole("button", { name: "Preview feedback" });
    const postFeedback = feedback.getByRole("button", { name: "Post feedback" });
    const feedbackWrites = syntheticCanvas.feedbackWrites.length;
    const comment = "Explain what each <route> shows. 地图 🌍\nCompare both legends & explain why.";
    await feedback.locator("summary").click();
    await feedbackText.fill(comment);
    assert.equal(await postFeedback.isVisible(), false);
    await previewFeedback.click();
    await feedbackPreview.waitFor();
    assert.match(await feedbackPreview.textContent(), /Course 42001.*Teacher 73001.*Assignment 81.*Test Student 73009.*Attempt 1/s);
    assert.equal(await feedbackPreview.locator("pre").textContent(), comment);
    assert.equal(await feedbackPreview.locator("pre").locator("route").count(), 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width);
    assert.equal(syntheticCanvas.feedbackWrites.length, feedbackWrites);
    await feedback.getByRole("button", { name: "Cancel preview" }).click();
    assert.equal(await postFeedback.isVisible(), false);
    assert.equal(syntheticCanvas.feedbackWrites.length, feedbackWrites);
    await previewFeedback.click();
    await postFeedback.click();
    await feedback.getByText(/^Canvas confirmed comment \d+ on the reviewed submission\./).waitFor();
    assert.equal(syntheticCanvas.feedbackWrites.length, feedbackWrites + 1);
    assert.deepEqual(syntheticCanvas.feedbackWrites.at(-1).fields, {
      "comment[text_comment]": "Explain what each &lt;route&gt; shows. 地图 🌍\nCompare both legends &amp; explain why.",
      "comment[attempt]": "1",
      "comment[group_comment]": "false",
    });
    assert.equal(await feedbackText.inputValue(), "");
    assert.equal(await postFeedback.isVisible(), false);
    assert.equal(requests.filter(request => request.endsWith("/api/v1/canvas/feedback/post")).length, 1);
    assert.ok(requests.every(request => new URL(request).origin === f.origin));
    assert.doesNotMatch(await feedback.innerText(), /Synthetic prior comment|Synthetic submission body|synthetic-rest-token/);
    results.push({ name: mobile ? "canvas-feedback-phone" : "canvas-feedback-desktop", width, height, status: "PASS", requests: requests.length });

    const verifier = page.locator("#teacher-canvas-verification");
    const startVerification = verifier.getByRole("button", { name: "Verify configured students" });
    const cancelVerification = verifier.getByRole("button", { name: "Cancel verification" });
    const resultRows = verifier.getByRole("listitem");
    const verificationRequests = requests.length;
    await verifier.locator("summary").click();
    for (const provider of ["0", "1"]) {
      await verifier.getByLabel("Approved verification assignment").selectOption(provider);
      await startVerification.click();
      await verifier.getByText("Verification finished. 30 of 30 results received.").waitFor();
      assert.equal(await resultRows.count(), 30);
      assert.equal(await verifier.getByText(/Student \d+ · Observed · Attempt 1/).count(), 30);
      assert.match(await resultRows.last().textContent(), /Student 74030 · Observed/);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width);
    }
    const entered = Promise.withResolvers();
    const stopped = Promise.withResolvers();
    syntheticVerification.state.mongo = async (_, signal) => {
      entered.resolve();
      if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      stopped.resolve();
      signal.throwIfAborted();
    };
    await startVerification.click();
    await entered.promise;
    await cancelVerification.click();
    await stopped.promise;
    await verifier.getByText("Verification cancelled. 0 of 30 results received.").waitFor();
    assert.equal(await verifier.getByText(/Cancelled — unchecked/).count(), 29);
    assert.doesNotMatch(await verifier.innerText(), /example\.mongodb\.net|synthetic-only-passphrase|synthetic_github_reader|README\.md/);
    assert.equal(requests.slice(verificationRequests).filter((request) => request === f.origin + "/api/v1/canvas/verification").length, 61);
    syntheticVerification.state.mongo = async () => {};
    results.push({ name: mobile ? "canvas-verification-phone" : "canvas-verification-desktop", width, height, status: "PASS", requests: requests.length });
    await context.close();
  }
  for (const scenario of [
    { name: "phone", width: 390, height: 844 },
    { name: "tablet", width: 820, height: 1180 },
    { name: "desktop", width: 1440, height: 1000 },
    {
      name: "coarse-touch-compact",
      width: 800,
      height: 480,
      hasTouch: true,
      compactTouch: true,
    },
    {
      name: "mixed-touch-compact",
      width: 800,
      height: 480,
      maxTouchPoints: 1,
      compactTouch: true,
      legacyMediaListener: true,
    },
  ]) {
    const {
      name,
      width,
      height,
      hasTouch = false,
      maxTouchPoints = 0,
      compactTouch = false,
      legacyMediaListener = false,
    } = scenario;
    const context = await browser.newContext({
      viewport: { width, height },
      ignoreHTTPSErrors: true,
      permissions: ["microphone"],
      hasTouch,
    });
    if (maxTouchPoints)
      await context.addInitScript((points) => {
        Object.defineProperty(Navigator.prototype, "maxTouchPoints", {
          configurable: true,
          get: () => points,
        });
      }, maxTouchPoints);
    if (legacyMediaListener)
      await context.addInitScript(() => {
        const nativeMatchMedia = window.matchMedia.bind(window);
        window.matchMedia = (query) => {
          const nativeList = nativeMatchMedia(query);
          if (!query.includes("pointer")) return nativeList;
          return {
            get matches() {
              return nativeList.matches;
            },
            media: nativeList.media,
            onchange: null,
            addListener: (listener) =>
              nativeList.addEventListener("change", listener),
            removeListener: (listener) =>
              nativeList.removeEventListener("change", listener),
            dispatchEvent: (event) => nativeList.dispatchEvent(event),
          };
        };
      });
    const page = await context.newPage();
    if (name === "phone") {
      const manifestResponse = await context.request.get(
        `${f.origin}/assets/pwa/manifest.webmanifest`,
      );
      assert.equal(manifestResponse.status(), 200);
      assert.match(manifestResponse.headers()["content-type"], /manifest\+json/u);
      const manifest = await manifestResponse.json();
      assert.equal(manifest.id, "/");
      assert.equal(manifest.start_url, "/");
      assert.equal(manifest.scope, "/");
      assert.equal(manifest.display, "standalone");
      assert.deepEqual(
        manifest.icons.map(({ src, sizes }) => [src, sizes]),
        [
          ["icon-192.png", "192x192"],
          ["icon-512.png", "512x512"],
        ],
      );
      for (const size of [180, 192, 512]) {
        const icon = await context.request.get(
          `${f.origin}/assets/pwa/icon-${size}.png`,
        );
        assert.equal(icon.status(), 200);
        assert.equal(icon.headers()["content-type"], "image/png");
      }
    }
    const requests = [],
      errors = [];
    page.on("request", (r) => requests.push(r.url()));
    page.on("pageerror", (e) => errors.push(e.message));
    await context.route("**/api/v1/auth/session", route => route.fulfill({status:200,contentType:"application/json",body: name === "phone" ? "not-json" : JSON.stringify({role:"unexpected-role",source:"local"})}));
    await page.goto(f.origin);
    await page.locator('[name="role"]').selectOption("admin");
    await context.unroute("**/api/v1/auth/session");
    await page.locator('[name="passphrase"]').fill(testPassphrase);
    await page.getByRole("button",{name:"Sign in",exact:true}).click();
    await page
      .locator("#question:not([disabled])")
      .waitFor()
      .catch(async () => {
        throw new Error(
          `Browser boot failed: ${JSON.stringify({ errors, requests, text: await page.locator("body").innerText() })}`,
        );
      });
    if (process.env.CLIENT_SCREENSHOTS && name === "desktop") {
      await page.evaluate(() => { document.querySelector(".prototype").textContent = "Synthetic demonstration"; });
      mkdirSync(process.env.CLIENT_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.CLIENT_SCREENSHOTS, "desktop-main.png") });
    }
    const capabilities = await page.evaluate(() => ({
      primaryFine: matchMedia("(pointer: fine)").matches,
      primaryCoarse: matchMedia("(pointer: coarse)").matches,
      anyCoarse: matchMedia("(any-pointer: coarse)").matches,
      maxTouchPoints: navigator.maxTouchPoints,
      touchCapable: document.documentElement.hasAttribute("data-touch-capable"),
    }));
    if (hasTouch)
      assert.deepEqual(capabilities, {
        primaryFine: false,
        primaryCoarse: true,
        anyCoarse: true,
        maxTouchPoints: 1,
        touchCapable: true,
      });
    else if (maxTouchPoints)
      assert.deepEqual(capabilities, {
        primaryFine: true,
        primaryCoarse: false,
        anyCoarse: false,
        maxTouchPoints,
        touchCapable: true,
      });
    else {
      assert.equal(capabilities.primaryFine, true);
      assert.equal(capabilities.touchCapable, false);
    }
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      compactTouch ? "" : "question",
    );
    const installGuide = page.locator(".install-help");
    if (name === "desktop") assert.equal(await installGuide.isVisible(), false);
    if (name === "phone") {
      assert.equal(await installGuide.isVisible(), true);
      assert.equal(
        await page.locator('link[rel="manifest"]').getAttribute("href"),
        "/assets/pwa/manifest.webmanifest",
      );
      assert.equal(
        await page.locator('link[rel="apple-touch-icon"]').getAttribute("href"),
        "/assets/pwa/icon-180.png",
      );
      assert.equal(
        await page.evaluate(() => navigator.serviceWorker.controller),
        null,
      );
      const scroll = await page.evaluate(() => window.scrollY);
      await installGuide.locator("summary").click();
      await installGuide.getByText(/add to home screen/i).waitFor();
      if (process.env.CLIENT_SCREENSHOTS) {
        mkdirSync(process.env.CLIENT_SCREENSHOTS, { recursive: true });
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({
          path: path.join(process.env.CLIENT_SCREENSHOTS, "phone-entry.png"),
        });
      }
      await installGuide.locator("summary").click();
      await page.evaluate((top) => window.scrollTo(0, top), scroll);
    }
    assert.equal(await page.locator('input[name="provider"]').count(), 3);
    assert.equal(await page.locator("#pairing").count(), 0);
    assert.equal(await page.locator("#speech-language").count(), 0);
    const cookies = await context.cookies();
    assert.equal(cookies.length, 1);
    assert.equal(cookies[0].name, "__Host-laita-session");
    assert.equal(cookies[0].httpOnly, true);
    assert.equal(cookies[0].secure, true);
    assert.equal(cookies[0].sameSite, "Lax");
    assert.equal(await page.evaluate(() => document.cookie), "");
    await page.reload();
    await page.locator("#question:not([disabled])").waitFor();
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      compactTouch ? "" : "question",
    );
    for (const state of ["DISABLED", "BUSY", "CLEANUP_FAILED", "READY"]) {
      speechState = state;
      const response = page.waitForResponse((r) =>
        r.url().endsWith("/choices"),
      );
      await page.locator("#question").fill(state === "READY" ? "" : state);
      assert.equal((await response).status(), 200);
      await page.waitForFunction(
        (expected) => document.querySelector("#mic").disabled === expected,
        state !== "READY",
      );
    }
    const whitespaceChoices = page.waitForResponse((r) =>
      r.url().endsWith("/choices"),
    );
    await page.locator("#question").fill(" ");
    assert.equal((await whitespaceChoices).status(), 200);
    assert.equal(await page.locator("#mic").isEnabled(), true);
    async function send(text) {
      const answerCount = await page
        .locator("#messages article.answer")
        .count();
      await page.locator("#question").fill(text);
      await page.locator("#send").click();
      await page.waitForFunction(
        (count) =>
          document.querySelectorAll("#messages article.answer").length > count,
        answerCount,
      );
    }
    assert.match(
      await page.locator("#model-status").innerText(),
      /installed, currently not in memory.*automatically/,
    );
    const userText =
      '### User **literal** <img src=x onerror="window.userExecuted=true">';
    const synthesis = page.waitForResponse((r) =>
      r.url().endsWith("/synthesis"),
    );
    const media = page.waitForResponse((r) =>
      /\/media\/[a-f0-9]{64}$/u.test(r.url()),
    );
    await send(userText);
    assert.equal((await synthesis).status(), 200);
    assert.equal((await media).status(), 200);
    assert.equal(
      await page
        .locator("#messages article.question .message-text")
        .textContent(),
      userText,
    );
    assert.equal(
      await page
        .locator("#messages article.question :is(img, strong, script)")
        .count(),
      0,
    );
    assert.equal(
      await page.locator("#messages article.answer .markdown h3").textContent(),
      "Synthetic heading",
    );
    assert.equal(
      await page
        .locator("#messages article.answer .markdown strong")
        .textContent(),
      "Bold",
    );
    assert.equal(
      await page.locator("#messages article.answer .markdown em").textContent(),
      "italic",
    );
    assert.equal(
      await page.locator("#messages article.answer ul li").count(),
      2,
    );
    assert.equal(
      await page.locator("#messages article.answer ol li").count(),
      2,
    );
    assert.match(
      await page.locator("#messages article.answer pre code").textContent(),
      /const x = "<script>"/,
    );
    assert.equal(
      await page
        .locator("#messages article.answer :is(script, img, a, iframe)")
        .count(),
      0,
    );
    assert.equal(
      await page.evaluate(() =>
        Boolean(window.modelExecuted || window.userExecuted),
      ),
      false,
    );
    assert.equal(
      await page.locator("#messages article.answer .message-text").isVisible(),
      true,
    );
    assert.equal(
      await page
        .locator("article.answer .message-text")
        .evaluate((element) => getComputedStyle(element).userSelect),
      "auto",
    );
    await page.waitForFunction(() =>
      ["Replay", "Play answer"].includes(
        document.querySelector("article.answer .answer-audio")?.textContent,
      ),
    );
    const beforeMuted = requests.filter((url) =>
      url.endsWith("/synthesis"),
    ).length;
    const feedbackReason = page
      .locator("#messages article.answer")
      .getByLabel("Optional feedback reason");
    await page
      .locator("#messages article.answer .feedback-controls summary")
      .click();
    await feedbackReason.fill("Unsent feedback survives audio changes");
    const reasonNode = await feedbackReason.elementHandle();
    await page.locator("#text-only").check();
    assert.equal(
      await feedbackReason.inputValue(),
      "Unsent feedback survives audio changes",
    );
    assert.equal(await reasonNode.evaluate((node) => node.isConnected), true);
    await reasonNode.dispose();
    await page.locator("#reset").click();
    await page.locator("#question:not([disabled])").waitFor();
    await send("Text remains primary while muted.");
    assert.equal(
      await page
        .locator("#messages article.answer")
        .getByLabel("Optional feedback reason")
        .inputValue(),
      "",
    );
    await page.waitForTimeout(100);
    assert.equal(
      requests.filter((url) => url.endsWith("/synthesis")).length,
      beforeMuted,
    );
    assert.equal(
      await page.locator("#messages article.answer .message-text").isVisible(),
      true,
    );
    await page.locator("#reset").click();
    await page.locator("#question:not([disabled])").waitFor();
    await send(courseQuestion);
    const courseSources = page.locator(
      "#messages article.answer .course-sources",
    );
    assert.equal(await courseSources.count(), 1);
    assert.equal(
      await courseSources.locator("summary").textContent(),
      "Course sources (1)",
    );
    assert.equal(await courseSources.getAttribute("open"), null);
    const sourceLink = courseSources.locator("a");
    assert.equal(
      await sourceLink.textContent(),
      `${coursePath} — ${courseSection}`,
    );
    assert.equal(await sourceLink.getAttribute("href"), courseUrl);
    assert.equal(await sourceLink.getAttribute("target"), "_blank");
    assert.equal(await sourceLink.getAttribute("rel"), "noopener noreferrer");
    assert.equal(
      await courseSources.locator("small").textContent(),
      `IA342 · ${courseCommit.slice(0, 12)}`,
    );
    assert.equal(
      await courseSources.locator("blockquote").textContent(),
      courseExcerpt,
    );
    await courseSources.locator("summary").click();
    if (process.env.CLIENT_SCREENSHOTS && name === "desktop") {
      await page.evaluate(() => { document.querySelector(".prototype").textContent = "Synthetic demonstration"; });
      mkdirSync(process.env.CLIENT_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.CLIENT_SCREENSHOTS, "desktop-grounded.png") });
    }
    assert.notEqual(await courseSources.getAttribute("open"), null);
    const sourceLayout = await page.evaluate(() => {
      const conversation = document.querySelector("#conversation");
      const excerpt = document.querySelector(".course-sources blockquote");
      const style = getComputedStyle(excerpt);
      const verticalScrollers = [
        ...document.querySelectorAll(
          "body, .app, main, .dialogue, #conversation, #composer, .session, .course-sources blockquote",
        ),
      ]
        .filter((element) => {
          const overflow = getComputedStyle(element).overflowY;
          return (
            ["auto", "scroll"].includes(overflow) &&
            element.scrollHeight > element.clientHeight
          );
        })
        .map((element) =>
          element.matches(".course-sources blockquote")
            ? "course-source-excerpt"
            : element.id || element.className || element.tagName,
        );
      return {
        conversationScrolls:
          conversation.scrollHeight > conversation.clientHeight,
        conversationOverflow: getComputedStyle(conversation).overflowY,
        excerptScrolls: excerpt.scrollHeight > excerpt.clientHeight,
        excerptOverflow: style.overflowY,
        excerptMaxHeight: style.maxHeight,
        verticalScrollers,
      };
    });
    if (compactTouch)
      assert.deepEqual(sourceLayout, {
        conversationScrolls: true,
        conversationOverflow: "auto",
        excerptScrolls: false,
        excerptOverflow: "visible",
        excerptMaxHeight: "none",
        verticalScrollers: ["conversation"],
      });
    else if (name === "desktop") {
      assert.equal(sourceLayout.excerptScrolls, true);
      assert.equal(sourceLayout.excerptOverflow, "auto");
      assert.notEqual(sourceLayout.excerptMaxHeight, "none");
      assert.ok(
        sourceLayout.verticalScrollers.includes("course-source-excerpt"),
      );
    }
    await page.locator("#text-only").uncheck();
    if (compactTouch) {
      await page.locator("#reset").click();
      await page.locator("#question:not([disabled])").waitFor();
      await page.locator("#text-only").check();
      await page.locator("#local-model").selectOption("llama3.1:8b");
      await page.waitForFunction(
        () => document.querySelector("#local-model").value === "llama3.1:8b",
      );
      await send("Show a long English answer.");
      await send("请显示一段较长的中文回答。");
      assert.deepEqual(
        await page
          .locator("article.answer .message-text")
          .nth(0)
          .locator("p")
          .allTextContents(),
        longEnglishAnswer.split("\n\n"),
      );
      assert.deepEqual(
        await page
          .locator("article.answer .message-text")
          .nth(1)
          .locator("p")
          .allTextContents(),
        longChineseAnswer.split("\n\n"),
      );
      const compactLayout = await page.evaluate(() => {
        const conversation = document.querySelector("#conversation");
        const heights = [
          ...document.querySelectorAll(
            "#providers label, #local-model, #mic, #send, .audio-mode, #reset",
          ),
        ].map((element) => element.getBoundingClientRect().height);
        const verticalScrollers = [
          ...document.querySelectorAll(
            "body, .app, main, .dialogue, #conversation, #composer, .session",
          ),
        ]
          .filter((element) => {
            const overflow = getComputedStyle(element).overflowY;
            return (
              ["auto", "scroll"].includes(overflow) &&
              element.scrollHeight > element.clientHeight
            );
          })
          .map((element) => element.id || element.className || element.tagName);
        return {
          pageScrolls:
            document.documentElement.scrollHeight > window.innerHeight + 1,
          transcriptScrolls:
            conversation.scrollHeight > conversation.clientHeight,
          transcriptOverflow: getComputedStyle(conversation).overflowY,
          transcriptTouchAction: getComputedStyle(conversation).touchAction,
          verticalScrollers,
          controlsAreTouchSized: heights.every((value) => value >= 44),
          providersVisible: [
            ...document.querySelectorAll('input[name="provider"]'),
          ].every((input) => input.parentElement.checkVisibility()),
          modelVisible: document
            .querySelector("#local-model")
            .checkVisibility(),
          primaryInputVisible: ["mic", "question", "send"].every((id) =>
            document.querySelector(`#${id}`).checkVisibility(),
          ),
          questionTextSelection: getComputedStyle(
            document.querySelector("#question"),
          ).userSelect,
          answerTextSelection: getComputedStyle(
            document.querySelector("article.answer .message-text"),
          ).userSelect,
          modelStatusRetained: {
            display: getComputedStyle(document.querySelector("#model-status"))
              .display,
            position: getComputedStyle(document.querySelector("#model-status"))
              .position,
            text: document.querySelector("#model-status").textContent,
          },
          disclosuresRetained: [
            ...document.querySelectorAll("#composer .disclosure"),
          ].map((element) => ({
            display: getComputedStyle(element).display,
            position: getComputedStyle(element).position,
            hasText: element.textContent.trim().length > 0,
          })),
          secondaryControlsVisible: ["reset", "text-only"].every((id) =>
            document.querySelector(`#${id}`).checkVisibility(),
          ),
          compactChromeHidden: [
            document.querySelector("header .prototype"),
            document.querySelector("footer"),
          ].every((element) => !element.checkVisibility()),
          disclosureLayoutSize: [
            ...document.querySelectorAll("#composer .disclosure"),
          ].map((element) => {
            const bounds = element.getBoundingClientRect();
            return { width: bounds.width, height: bounds.height };
          }),
          dogWidth: document.querySelector("#dog").getBoundingClientRect()
            .width,
        };
      });
      assert.deepEqual(compactLayout, {
        pageScrolls: false,
        transcriptScrolls: true,
        transcriptOverflow: "auto",
        transcriptTouchAction: "pan-y pinch-zoom",
        verticalScrollers: ["conversation"],
        controlsAreTouchSized: true,
        providersVisible: true,
        modelVisible: true,
        primaryInputVisible: true,
        questionTextSelection: "auto",
        answerTextSelection: "auto",
        modelStatusRetained: {
          display: "block",
          position: "absolute",
          text: "Llama 8B — installed, currently not in memory. It will load automatically when needed.",
        },
        disclosuresRetained: [
          { display: "block", position: "absolute", hasText: true },
          { display: "block", position: "absolute", hasText: true },
        ],
        secondaryControlsVisible: true,
        compactChromeHidden: true,
        disclosureLayoutSize: [
          { width: 1, height: 1 },
          { width: 1, height: 1 },
        ],
        dogWidth: 28,
      });
      await page.setViewportSize({ width: 800, height: 240 });
      await page.waitForFunction(() => window.innerHeight === 240);
      await page.locator("#question").focus();
      const reducedViewport = await page.evaluate(() => {
        const conversation = document.querySelector("#conversation");
        const question = document
          .querySelector("#question")
          .getBoundingClientRect();
        const send = document.querySelector("#send").getBoundingClientRect();
        return {
          conversationVisible:
            conversation.getBoundingClientRect().height > 0 &&
            getComputedStyle(conversation).display !== "none",
          questionVisible:
            question.top >= 0 && question.bottom <= window.innerHeight,
          sendVisible: send.top >= 0 && send.bottom <= window.innerHeight,
          sendEnabled: !document.querySelector("#send").disabled,
        };
      });
      assert.deepEqual(reducedViewport, {
        conversationVisible: true,
        questionVisible: true,
        sendVisible: true,
        sendEnabled: true,
      });
      if (process.env.CLIENT_SCREENSHOTS) {
        mkdirSync(process.env.CLIENT_SCREENSHOTS, { recursive: true });
        await page.screenshot({
          path: path.join(
            process.env.CLIENT_SCREENSHOTS,
            `${name}-keyboard-client.png`,
          ),
        });
      }
      await page.setViewportSize({ width: 800, height: 480 });
      await page.waitForFunction(() => window.innerHeight === 480);
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      await page.evaluate(() => {
        const root = document.documentElement;
        root.toggleAttribute("data-virtual-keyboard", true);
        root.style.setProperty("--visual-viewport-height", "240px");
        root.style.setProperty("--visual-viewport-offset-top", "0px");
      });
      const overlayViewport = await page.evaluate(() => {
        const conversation = document
          .querySelector("#conversation")
          .getBoundingClientRect();
        const question = document
          .querySelector("#question")
          .getBoundingClientRect();
        const send = document.querySelector("#send").getBoundingClientRect();
        return {
          conversationHeight: conversation.height,
          questionTop: question.top,
          questionBottom: question.bottom,
          sendTop: send.top,
          sendBottom: send.bottom,
        };
      });
      assert.ok(
        overlayViewport.conversationHeight > 0 &&
          overlayViewport.questionTop >= 0 &&
          overlayViewport.questionBottom <= 240 &&
          overlayViewport.sendTop >= 0 &&
          overlayViewport.sendBottom <= 240,
        JSON.stringify(overlayViewport),
      );
      await page.evaluate(() => {
        const root = document.documentElement;
        root.removeAttribute("data-virtual-keyboard");
        root.style.removeProperty("--visual-viewport-height");
        root.style.removeProperty("--visual-viewport-offset-top");
      });
      await page.setViewportSize({ width: 800, height: 1024 });
      await page.waitForFunction(() => window.innerHeight === 1024);
      const tallOverlayViewport = await page.evaluate(() => {
        // Sample the synthetic state before a native resize callback can replace it.
        const root = document.documentElement;
        root.toggleAttribute("data-virtual-keyboard", true);
        root.style.setProperty("--visual-viewport-height", "420px");
        root.style.setProperty("--visual-viewport-offset-top", "0px");
        const conversation = document
          .querySelector("#conversation")
          .getBoundingClientRect();
        const question = document
          .querySelector("#question")
          .getBoundingClientRect();
        const send = document.querySelector("#send").getBoundingClientRect();
        return {
          conversationHeight: conversation.height,
          questionTop: question.top,
          questionBottom: question.bottom,
          sendTop: send.top,
          sendBottom: send.bottom,
        };
      });
      assert.ok(
        tallOverlayViewport.conversationHeight > 0 &&
          tallOverlayViewport.questionTop >= 0 &&
          tallOverlayViewport.questionBottom <= 420 &&
          tallOverlayViewport.sendTop >= 0 &&
          tallOverlayViewport.sendBottom <= 420,
        JSON.stringify(tallOverlayViewport),
      );
      await page.evaluate(() => {
        const root = document.documentElement;
        root.removeAttribute("data-virtual-keyboard");
        root.style.removeProperty("--visual-viewport-height");
        root.style.removeProperty("--visual-viewport-offset-top");
      });
      await page.setViewportSize({ width: 800, height: 480 });
      await page.waitForFunction(() => window.innerHeight === 480);
      await page.locator("#question").blur();
      await page.locator("#text-only").uncheck();
    }
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    if (process.env.CLIENT_SCREENSHOTS) {
      mkdirSync(process.env.CLIENT_SCREENSHOTS, { recursive: true });
      await page.screenshot({
        path: path.join(process.env.CLIENT_SCREENSHOTS, `${name}-client.png`),
      });
    }
    await page.locator("#reset").click();
    await page.locator("#question:not([disabled])").waitFor();
    assert.equal(await page.locator("#mic").isEnabled(), true);
    const transcription = page.waitForRequest((r) =>
      r.url().endsWith("/transcriptions"),
    );
    const calls = f.calls();
    await page.locator("#mic").click();
    await page.waitForTimeout(600);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await page.locator("#messages article.answer").waitFor();
    assert.equal(
      (await transcription).headers()["x-input-language"],
      undefined,
    );
    assert.equal(
      await page
        .locator("#messages article.question .message-text")
        .textContent(),
      "Explain a research question.",
    );
    assert.equal(f.calls(), calls + 1);
    await page.locator("#reset").click();
    await page.locator("#question:not([disabled])").waitFor();
    await page.locator('input[value="Compare"]').check();
    const beforeCompare = requests.filter((url) =>
      url.endsWith("/synthesis"),
    ).length;
    await send("Compare research explanations.");
    assert.equal(await page.locator(".comparison article").count(), 2);
    await page.waitForTimeout(100);
    assert.equal(
      requests.filter((url) => url.endsWith("/synthesis")).length,
      beforeCompare,
    );
    const compareSynthesis = page.waitForResponse((r) =>
      r.url().endsWith("/synthesis"),
    );
    const compareMedia = page.waitForResponse((r) =>
      /\/media\/[a-f0-9]{64}$/u.test(r.url()),
    );
    await page.locator(".comparison article .answer-audio").nth(1).click();
    assert.equal((await compareSynthesis).status(), 200);
    assert.equal((await compareMedia).status(), 200);
    await page.locator("#stop-audio").waitFor({ state: "visible" });
    await page.locator("#stop-audio").click();
    await page.locator("#stop-audio").waitFor({ state: "hidden" });
    assert.equal(
      requests.filter((url) => url.endsWith("/synthesis")).length,
      beforeCompare + 1,
    );
    await page.locator("#reset").click();
    assert.notEqual(
      await page.locator("#dog").getAttribute("data-state"),
      "speaking",
    );
    await page.locator("#question:not([disabled])").waitFor();
    await page.locator("#question").fill("slow research question");
    await page.locator("#send").click();
    await page.locator('#status[data-phase="waiting"]').waitFor();
    if (compactTouch) {
      await page.evaluate(() => {
        const root = document.documentElement;
        root.toggleAttribute("data-virtual-keyboard", true);
        root.style.setProperty("--visual-viewport-height", "240px");
        root.style.setProperty("--visual-viewport-offset-top", "0px");
      });
    }
    assert.equal(await page.locator("#cancel").isVisible(), true);
    assert.ok((await page.locator("#cancel").boundingBox()).height >= 44);
    await page.locator("#cancel").click();
    if (compactTouch) {
      await page.evaluate(() => {
        const root = document.documentElement;
        root.removeAttribute("data-virtual-keyboard");
        root.style.removeProperty("--visual-viewport-height");
        root.style.removeProperty("--visual-viewport-offset-top");
      });
    }
    await page.locator("#reset").click();
    await page.locator("#question:not([disabled])").waitFor();
    await page.waitForTimeout(3200);
    assert.equal(await page.locator("#messages article").count(), 0);
    await page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = () =>
        Promise.reject(new DOMException("Denied", "NotAllowedError"));
    });
    await page.locator("#mic").click();
    await page.locator('#status[data-phase="error"]').waitFor();
    await send("Typed after microphone denied.");
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    assert.deepEqual(errors, []);
    assert.ok(
      requests.every(
        (url) =>
          (url.startsWith(f.origin + "/") ||
            url.startsWith("blob:" + f.origin + "/")) &&
          !/\/api\/(admin|instructor)|\/pairings|openai\.com|11434/.test(url),
      ),
    );
    // Same-app history: complete content, safe DOM, feedback and review without inference.
    assert.match(
      await page.locator("#development-notice").innerText(),
      /retained locally/,
    );
    const noticeText = await page
      .locator("#development-notice > span")
      .first()
      .innerText();
    assert.ok(noticeText.length < 180);
    assert.match(
      noticeText,
      /Text, transcripts, answers, feedback and diagnostics/,
    );
    assert.match(noticeText, /Raw audio is temporary, never archived/);
    if (process.env.CLIENT_SCREENSHOTS && name === "desktop") {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: path.join(
          process.env.CLIENT_SCREENSHOTS,
          "desktop-compact-notice.png",
        ),
      });
    }
    // Open history from an established multi-turn chat, with an unsent draft.
    await page.locator("#reset").click();
    await page.locator("#question:not([disabled])").waitFor();
    await page.locator('input[name="provider"][value="Local"]').check();
    await page.locator("#text-only").check();
    await send("Synthetic first turn before history.");
    await page.locator("#question:not([disabled])").waitFor();
    await send("Synthetic follow-up before history.");
    await page.locator("#question:not([disabled])").waitFor();
    const previousContext = structuredClone(f.requests.at(-1).input.history);
    assert.ok(previousContext.length >= 2);
    const beforeMessages = await page
      .locator("#messages article .message-text")
      .allTextContents();
    assert.equal(await page.locator("#messages article.question").count(), 2);
    await page
      .locator("#question")
      .fill("Unsent draft while reviewing history");
    const beforeHistory = f.calls();
    const historyRequests = [];
    context.once("page", (opened) => {
      opened.on("request", (r) => {
        historyRequests.push(r.url());
        requests.push(r.url());
      });
      opened.on("pageerror", (e) => errors.push(e.message));
    });
    const popup = context.waitForEvent("page");
    await page.locator("#history-open").click();
    const historyPage = await popup;
    await historyPage.locator(".history-row").first().waitFor();
    assert.equal(await historyPage.evaluate(() => window.opener), null);
    assert.equal(new URL(historyPage.url()).pathname, "/history");
    assert.equal(await historyPage.locator("#history-dialog").count(), 0);
    const historyDialog = historyPage.locator("#history-page");
    assert.equal(await historyDialog.locator(".history-turn").count(), 0);
    assert.equal(await historyDialog.locator(".history-row").count(), 20);
    assert.equal(await historyDialog.locator("pre, textarea").count(), 0);
    await historyDialog.getByText("Filters", { exact: true }).click();
    const beforeInvalidDate = requests.filter((url) =>
      url.endsWith("/history/query"),
    ).length;
    await historyDialog
      .getByLabel("Since", { exact: true })
      .fill("10000-01-01T00:00");
    await historyDialog
      .getByRole("button", { name: "Search / refresh", exact: true })
      .click();
    await historyDialog
      .getByText("Enter a valid date and time before searching.", {
        exact: true,
      })
      .waitFor();
    assert.equal(
      requests.filter((url) => url.endsWith("/history/query")).length,
      beforeInvalidDate,
    );
    await historyDialog.getByLabel("Since", { exact: true }).fill("");
    await historyDialog
      .getByRole("button", { name: "Search / refresh", exact: true })
      .click();
    await historyDialog.getByText(/records on this page/).waitFor();
    await historyPage.locator(".history-row").first().click();
    await historyPage.locator(".history-turn").first().waitFor();
    const turn = historyPage.locator(".history-turn").first();
    await turn
      .getByRole("button", { name: "Not helpful", exact: true })
      .click();
    await turn.getByText("Saved · Not helpful", { exact: true }).waitFor();
    await turn.locator(".owner-annotation summary").click();
    await turn.locator("select").selectOption("REVIEWED");
    await turn
      .getByRole("textbox", { name: "Owner review note", exact: true })
      .fill("Synthetic accessible review note");
    assert.equal(
      await turn
        .getByRole("textbox", { name: "Suspicion reason", exact: true })
        .count(),
      1,
    );
    await turn.getByRole("button", { name: "Save Owner review" }).click();
    await turn.getByText("Review saved.", { exact: true }).waitFor();
    assert.equal(
      await historyPage.evaluate(
        () => window.modelExecuted || window.userExecuted || false,
      ),
      false,
    );
    assert.equal(f.calls(), beforeHistory);
    await historyPage
      .getByRole("link", { name: "Back to results", exact: true })
      .click();
    await historyDialog.locator(".history-row").first().waitFor();
    await historyDialog
      .getByLabel("Search history")
      .fill("Missing snapshot fixture");
    await historyDialog
      .getByRole("button", { name: "Search / refresh", exact: true })
      .click();
    await historyDialog
      .locator(".history-row")
      .filter({ hasText: "Missing snapshot fixture" })
      .click();
    const missingTurn = historyDialog
      .locator(".history-turn")
      .filter({ hasText: "Missing snapshot fixture" });
    await missingTurn
      .getByText("Execution trace / identifiers", { exact: true })
      .click();
    await missingTurn
      .getByText(`Searched snapshot: IA340 @ ${"c".repeat(40)}`, {
        exact: false,
      })
      .waitFor();
    assert.match(
      await missingTurn
        .locator("summary")
        .filter({ hasText: "Sources (" })
        .textContent(),
      /Sources \(0\)/,
    );
    assert.equal(f.calls(), beforeHistory);
    await historyDialog
      .getByRole("link", { name: "Back to results", exact: true })
      .click();
    await historyDialog.getByLabel("Search history").fill("Scan fixture");
    await historyDialog
      .getByRole("button", { name: "Search / refresh", exact: true })
      .click();
    await historyDialog.getByText(/20 records on this page/).waitFor();
    assert.equal(await historyDialog.locator(".history-row").count(), 20);
    assert.doesNotMatch(
      await historyDialog.innerText(),
      /DETAIL_ONLY_ANSWER_189/,
    );
    assert.equal(
      await historyDialog.locator(".history-turn, pre, textarea").count(),
      0,
    );
    assert.match(
      await historyDialog.locator(".history-row").first().innerText(),
      /LOCAL \/ synthetic-summary/,
    );
    assert.ok(
      await historyPage.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    const rows = await historyDialog
      .locator(".history-row")
      .evaluateAll((nodes) =>
        nodes.map((n) => n.getBoundingClientRect().height),
      );
    assert.ok(
      rows.every((h) => h <= 180),
      `${name}: compact summary rows`,
    );
    if (process.env.CLIENT_SCREENSHOTS)
      await historyPage.screenshot({
        path: path.join(process.env.CLIENT_SCREENSHOTS, `${name}-history.png`),
      });
    const firstPage = await historyDialog
      .locator(".history-row")
      .first()
      .innerText();
    await historyDialog
      .getByRole("link", { name: "Older records", exact: true })
      .click();
    await historyPage.waitForFunction(() =>
      new URLSearchParams(location.search).has("before"),
    );
    await historyDialog.getByText(/20 records on this page/).waitFor();
    assert.equal(await historyDialog.locator(".history-row").count(), 20);
    assert.notEqual(
      await historyDialog.locator(".history-row").first().innerText(),
      firstPage,
    );
    await historyPage.goBack();
    await historyDialog.getByText(/20 records on this page/).waitFor();
    assert.equal(
      await historyDialog.locator(".history-row").first().innerText(),
      firstPage,
    );
    await historyDialog
      .getByRole("link", { name: "Problems", exact: true })
      .click();
    await historyDialog.getByText(/4 records on this page/).waitFor();
    assert.equal(await historyDialog.locator(".history-row").count(), 4);
    for (const badge of [
      "TTS problem",
      "Not helpful",
      "Problem reported",
      "Owner confirmed issue",
    ])
      assert.ok(
        await historyDialog.getByText(badge, { exact: true }).isVisible(),
      );
    await historyDialog
      .locator(".history-row")
      .filter({ hasText: "TTS problem" })
      .click();
    await historyDialog.locator(".history-turn").waitFor();
    assert.match(
      await historyDialog.locator(".history-turn").innerText(),
      /DETAIL_ONLY_ANSWER_189/,
    );
    assert.match(
      await historyDialog.locator(".history-turn").innerText(),
      /Text: SUCCESS/,
    );
    assert.equal(await historyDialog.locator(".history-row").count(), 0);
    const beforeReloadRequests = requests.length;
    await historyPage.reload();
    await historyDialog.locator(".history-turn").waitFor();
    assert.ok(
      requests
        .slice(beforeReloadRequests)
        .every((url) => !url.includes("/api/v1/input/")),
    );
    if (process.env.CLIENT_SCREENSHOTS && name === "desktop")
      await historyPage.screenshot({
        path: path.join(
          process.env.CLIENT_SCREENSHOTS,
          "desktop-history-detail.png",
        ),
      });
    assert.match(
      await historyDialog.locator(".history-turn").innerText(),
      /DETAIL_ONLY_ANSWER_189/,
    );
    await historyDialog.getByText("Execution trace / identifiers", { exact: true }).click();
    const copiedReference = (await historyDialog.locator("pre").filter({ hasText: "Correlation:" }).innerText())
      .match(/Correlation: ([0-9a-f-]{36})\n/u)?.[1];
    assert.equal(copiedReference, diagnosticReference);
    await historyDialog.getByRole("link", { name: "Back to results", exact: true }).click();
    const localDiagnostic = historyDialog.locator("details").filter({ hasText: "Find a local diagnostic" });
    await localDiagnostic.locator("summary").click();
    const diagnosticInput = localDiagnostic.getByLabel("Correlation reference");
    const paddedReference = `  ${copiedReference}  `;
    await diagnosticInput.fill(paddedReference);
    assert.equal(await diagnosticInput.inputValue(), paddedReference);
    await localDiagnostic.getByRole("button", { name: "Look up reference" }).click();
    await localDiagnostic.getByText("SUCCESS · RECORDED. Observed stages TTS (SERVER).", { exact: true }).waitFor();
    assert.doesNotMatch(await localDiagnostic.innerText(), /DETAIL_ONLY_ANSWER_189|Scan fixture 0/);
    assert.ok(await historyPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await diagnosticInput.fill(randomUUID());
    await diagnosticInput.press("Enter");
    await localDiagnostic.getByText("No matching diagnostic in the recent History window.", { exact: true }).waitFor();
    assert.equal(f.calls(), beforeHistory);
    assert.ok(
      historyRequests.every((url) => !url.includes("/api/v1/input/")),
      "History must not initialize a chat/provider session",
    );
    assert.equal(new URL(page.url()).pathname, "/");
    assert.deepEqual(
      await page.locator("#messages article .message-text").allTextContents(),
      beforeMessages,
    );
    assert.equal(
      await page.locator("#question").inputValue(),
      "Unsent draft while reviewing history",
    );
    assert.deepEqual(errors, []);
    // Back to chat remains usable in the history tab, without altering the original.
    await historyDialog
      .getByRole("link", { name: "Back to chat", exact: true })
      .click();
    await historyPage.locator("#question:not([disabled])").waitFor();
    assert.equal(new URL(historyPage.url()).pathname, "/");
    assert.equal(f.calls(), beforeHistory);
    await historyPage.close();
    await page.bringToFront();
    await send("Synthetic continuation after history.");
    await page.locator("#question:not([disabled])").waitFor();
    const continuedContext = f.requests.at(-1).input.history;
    assert.deepEqual(
      continuedContext.slice(0, previousContext.length),
      previousContext,
    );
    assert.equal(continuedContext.length, previousContext.length + 2);
    assert.equal(
      continuedContext.at(-2).content,
      "Synthetic follow-up before history.",
    );
    assert.equal(continuedContext.at(-1).role, "ASSISTANT");
    assert.doesNotMatch(
      JSON.stringify(continuedContext),
      /DETAIL_ONLY_ANSWER_189|Scan fixture/,
    );
    assert.equal(await page.locator("#messages article.question").count(), 3);
    await page.locator("#usage-open").click();
    assert.match(
      await page.locator("#usage-dialog").innerText(),
      /No fixed text-retention deadline/,
    );
    await page.locator("#usage-close").click();
    await page.locator("#question").fill("Unsent prior draft");
    await page.evaluate(() =>
      window.dispatchEvent(
        new PageTransitionEvent("pagehide", { persisted: true }),
      ),
    );
    assert.equal(await page.locator("#messages article").count(), 0);
    assert.equal(await page.locator("#question").inputValue(), "");
    await page.evaluate(() =>
      window.dispatchEvent(
        new PageTransitionEvent("pageshow", { persisted: true }),
      ),
    );
    await page.locator("#question:not([disabled])").waitFor();
    assert.equal(await page.locator("#messages article").count(), 0);
    results.push({
      name,
      width,
      height,
      status: "PASS",
      requests: requests.length,
    });
    await context.close();
  }
  console.log(JSON.stringify({ browser: browser.version(), results }, null, 2));
} finally {
  await browser?.close();
  f?.close();
  persistence?.close();
  rmSync(root, { recursive: true, force: true });
}
