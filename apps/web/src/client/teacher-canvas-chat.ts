import { ClientError, type InputApi } from "./api.ts";
import { bindTeacherForm } from "./teacher-form.ts";

export async function mountCanvasChat(api: InputApi) {
  const localRouting = await api
    .canvasChatEnabled("local")
    .catch((error: unknown) => {
      if (error instanceof ClientError && [404, 503].includes(error.status))
        return false;
      throw error;
    });
  if (!localRouting && !(await api.canvasChatEnabled())) return;
  const plugin = document.getElementById("canvas-chat-plugin")!;
  plugin.querySelector<HTMLElement>("#canvas-chat-routing")!.hidden =
    !localRouting;
  const routing = plugin.querySelector<HTMLSelectElement>("#canvas-chat-mode")!;
  const answer = plugin.querySelector<HTMLElement>("#canvas-chat-answer")!;
  const question = plugin.querySelector<HTMLInputElement>(
    "#canvas-chat-question",
  )!;
  bindTeacherForm(
    plugin.querySelector<HTMLFormElement>("form")!,
    answer,
    async (signal) => {
      const text = await api.canvasChat(
        question.value,
        signal,
        localRouting && routing.value === "local" ? "local" : "direct",
      );
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
