import type { InputApi } from "./api.ts";
import { bindTeacherForm } from "./teacher-form.ts";

export async function mountCanvasChat(api: InputApi) {
  if (!(await api.canvasChatEnabled())) return;
  const plugin = document.getElementById("canvas-chat-plugin")!;
  const answer = plugin.querySelector<HTMLElement>("#canvas-chat-answer")!;
  const question = plugin.querySelector<HTMLInputElement>(
    "#canvas-chat-question",
  )!;
  bindTeacherForm(
    plugin.querySelector<HTMLFormElement>("form")!,
    answer,
    async (signal) => {
      const text = await api.canvasChat(question.value, signal);
      signal.throwIfAborted();
      answer.textContent = text;
    },
    {
      signIn: "Launch LAITA from the configured Canvas course as the Teacher.",
      unavailable:
        "Canvas Chat is unavailable. Check the Test Student, assignment, permissions and REST setup, then try again.",
    },
  );
  plugin.hidden = false;
}
