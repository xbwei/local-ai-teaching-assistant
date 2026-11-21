import { ClientError } from "./api.ts";

export function bindTeacherForm(
  form: HTMLFormElement,
  status: HTMLElement,
  run: (signal: AbortSignal) => Promise<void>,
  messages = {
    signIn: "Sign in again as the local Teacher.",
    unavailable: "Unavailable. Check the local setup and try again.",
  },
) {
  const send = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const cancel = form.querySelector<HTMLButtonElement>(
    'button[type="button"]',
  )!;
  let pending: AbortController | undefined;
  cancel.onclick = () => pending?.abort();
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (pending) return;
    const controller = new AbortController();
    pending = controller;
    send.disabled = true;
    cancel.hidden = false;
    status.textContent = "Working…";
    try {
      await run(controller.signal);
    } catch (error) {
      if (pending !== controller) return;
      status.textContent = controller.signal.aborted
        ? "Cancelled."
        : error instanceof ClientError && [401, 403].includes(error.status)
          ? messages.signIn
          : messages.unavailable;
    } finally {
      if (pending === controller) {
        pending = undefined;
        send.disabled = false;
        cancel.hidden = true;
      }
    }
  };
  window.addEventListener("pagehide", () => {
    pending?.abort();
    pending = undefined;
    form.reset();
    send.disabled = false;
    cancel.hidden = true;
    status.textContent = "";
  });
}
