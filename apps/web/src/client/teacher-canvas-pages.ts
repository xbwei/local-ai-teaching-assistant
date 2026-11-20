import {
  readCanvasPageDraft,
  type CanvasPagePreview,
} from "@laita/contracts/browser";
import type { InputApi } from "./api.ts";
import { renderMessageText } from "./markdown.ts";

const get = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

function fromMarkdown(markdown: string) {
  const fragment = document.createElement("div");
  renderMessageText(fragment, { role: "answer", text: markdown });
  for (const heading of Array.from(fragment.querySelectorAll("h1,h4,h5,h6"))) {
    const replacement = document.createElement("h2");
    replacement.append(...Array.from(heading.childNodes));
    heading.replaceWith(replacement);
  }
  fragment
    .querySelectorAll("ol")
    .forEach((list) => list.removeAttribute("start"));
  return fragment;
}

export function mountTeacherCanvasPages(api: InputApi) {
  const tool = get("teacher-canvas-pages");
  const status = get("canvas-page-status");
  const form = get<HTMLFormElement>("canvas-page-form");
  const title = get<HTMLInputElement>("canvas-page-title");
  const body = get<HTMLTextAreaElement>("canvas-page-body");
  const previewButton = form.querySelector<HTMLButtonElement>(
    'button[type="submit"]',
  )!;
  const preview = get("canvas-page-preview");
  const target = get("canvas-page-target");
  const previewTitle = get("canvas-page-preview-title");
  const previewBody = get("canvas-page-preview-body");
  const html = get("canvas-page-html");
  const confirm = get<HTMLButtonElement>("canvas-page-confirm");
  let pending: AbortController | undefined;
  let approved: CanvasPagePreview | undefined;

  function clearPreview() {
    approved = undefined;
    preview.hidden = true;
    target.textContent = "";
    previewTitle.textContent = "";
    previewBody.replaceChildren();
    html.textContent = "";
  }
  function lock(locked: boolean) {
    title.disabled =
      body.disabled =
      previewButton.disabled =
      confirm.disabled =
        locked;
  }
  tool.hidden = false;
  void api
    .canvasPagesEnabled()
    .then((enabled) => {
      if (!enabled) throw new Error("CANVAS_UNAVAILABLE");
      form.hidden = false;
      status.textContent =
        "Use non-sensitive teaching material. Preview checks the destination. Create sends the reviewed content to Canvas.";
    })
    .catch(() => {
      status.textContent =
        "Canvas Page creation is unavailable. Check the owner’s REST setup and reopen the signed Teacher launch.";
    });

  form.addEventListener("input", () => {
    if (approved)
      status.textContent =
        "Draft changed. Preview again before creating the Page.";
    clearPreview();
  });
  get("canvas-page-cancel").onclick = () => {
    clearPreview();
    status.textContent = "Preview cancelled.";
    previewButton.focus();
  };

  form.onsubmit = async (event) => {
    event.preventDefault();
    if (pending) return;
    clearPreview();
    const fragment = fromMarkdown(body.value);
    let draft;
    try {
      draft = readCanvasPageDraft({
        title: title.value.trim(),
        body: fragment.innerHTML,
      });
    } catch {
      status.textContent =
        "Enter a title and a supported Markdown body under the page size limit.";
      return;
    }
    const controller = new AbortController();
    pending = controller;
    lock(true);
    status.textContent = "Checking the Canvas destination…";
    try {
      const current = await api.previewCanvasPage(draft, controller.signal);
      if (pending !== controller) return;
      approved = current;
      const course = document.createElement("bdi");
      course.textContent = current.target.courseName;
      target.replaceChildren(
        course,
        ` · Course ${current.target.courseId} · Teacher ${current.target.teacherId} · ${current.target.origin}`,
      );
      previewTitle.textContent = current.draft.title;
      previewBody.replaceChildren(fragment);
      html.textContent = current.draft.body;
      preview.hidden = false;
      status.textContent =
        "Preview ready. Review the destination and content before creating the Page.";
    } catch {
      if (pending === controller)
        status.textContent =
          "Preview unavailable. Check the signed Teacher session, REST credentials and course.";
    } finally {
      if (pending === controller) {
        pending = undefined;
        lock(false);
      }
    }
  };

  confirm.onclick = async () => {
    if (pending || !approved || preview.hidden) return;
    const current = approved;
    clearPreview();
    const controller = new AbortController();
    pending = controller;
    lock(true);
    status.textContent =
      "Creating the unpublished Page and checking it in Canvas…";
    const uncertain =
      "The Page result could not be confirmed. Check Pages in Canvas before trying again.";
    try {
      const result = await api.createCanvasPage(current, controller.signal);
      if (pending !== controller) return;
      if (result.status === "VERIFIED") {
        status.textContent = `Canvas verified unpublished Page ${result.pageId}.`;
        form.reset();
      } else {
        status.textContent =
          result.status === "UNVERIFIED"
            ? `Canvas returned Page ${result.pageId}, but LAITA could not verify it. Check Pages in Canvas before trying again.`
            : uncertain;
      }
    } catch {
      if (pending === controller) status.textContent = uncertain;
    } finally {
      if (pending === controller) {
        pending = undefined;
        lock(false);
        previewButton.focus();
      }
    }
  };

  window.addEventListener("pagehide", () => {
    pending?.abort();
    pending = undefined;
    clearPreview();
    form.reset();
    lock(false);
    status.textContent = "";
  });
}
