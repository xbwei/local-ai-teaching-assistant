import { isCanvasInventoryKind } from "@laita/contracts/browser";
import type { InputApi } from "./api.ts";
import { bindTeacherForm } from "./teacher-form.ts";

const labels = {
  pages: "Pages approved for Modules",
  "editable-assignments": "Assignments approved for title edits",
  "module-assignments": "Assignments approved for Modules",
  modules: "Unpublished Module destinations",
};

export async function mountCanvasInventory(api: InputApi) {
  const kinds = await api.canvasInventoryOptions();
  if (!kinds.length) return;
  const tool = document.getElementById("teacher-canvas-inventory")!;
  const form = tool.querySelector("form")!;
  const kind = form.querySelector("select")!;
  const status = tool.querySelector<HTMLElement>("[role=status]")!;
  const results = tool.querySelector("ul")!;
  kind.replaceChildren(
    ...kinds.map((entry) => new Option(labels[entry], entry)),
  );

  kind.addEventListener("change", () => {
    status.textContent = "";
    results.replaceChildren();
  });
  bindTeacherForm(
    form,
    status,
    async (signal) => {
      const selected = kind.value;
      if (!isCanvasInventoryKind(selected)) return;
      results.replaceChildren();
      kind.disabled = true;
      try {
        const { target, entries } = await api.canvasInventory(selected, signal);
        signal.throwIfAborted();
        status.textContent = `${target.courseName} · Course ${target.courseId}`;
        results.replaceChildren(
          ...entries.map(({ id, title, published }) => {
            const entry = document.createElement("li");
            const name = document.createElement("bdi");
            name.textContent = title;
            entry.append(
              name,
              ` · ID ${id} · ${published ? "Published" : "Unpublished"}`,
            );
            return entry;
          }),
        );
      } finally {
        kind.disabled = false;
      }
    },
    {
      signIn: "Launch LAITA from the configured Canvas course as the Teacher.",
      unavailable:
        "Canvas inventory is unavailable. Check the current Canvas settings and try again.",
    },
  );
  window.addEventListener("pagehide", () => results.replaceChildren());
  tool.hidden = false;
}
