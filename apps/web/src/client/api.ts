import {
  isInputBuild,
  isLocalSelection,
  isInputChoices,
  isInputJob,
  isInputSession,
  isInputRef,
  isTtsMedia,
  isTtsSkipped,
  type InputSubmission,
  type TtsSynthesisRequest,
} from "@laita/contracts/browser";
export class ClientError extends Error {
  history?: import("@laita/contracts/browser").HistoryRef;
  status: number;
  constructor(status = 0) {
    super("Request unavailable");
    this.status = status;
  }
}
/** Only fixed same-origin browser/input routes; never accepts a host or credential. */
export class InputApi {
  recordingIncomplete = false;
  private owner = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  private sequence = 0;
  private session = "";
  private fetcher: typeof fetch;
  constructor(fetcher: typeof fetch = (input, init) => fetch(input, init)) {
    this.fetcher = fetcher;
  }
  private async request(
    path: string,
    method: string,
    body?: string | Uint8Array,
    signal?: AbortSignal,
    extra: Record<string, string> = {},
  ) {
    const timeout = AbortSignal.timeout(45_000);
    const response = await this.fetcher(path, {
      method,
      credentials: "same-origin",
      mode: "same-origin",
      redirect: "error",
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: {
        "x-owner-client": this.owner,
        ...(this.session && path.startsWith("/api/v1/input/")
          ? { "x-input-session": this.session }
          : {}),
        ...(typeof body === "string"
          ? { "Content-Type": "application/json" }
          : {}),
        ...extra,
      },
      ...(body !== undefined ? { body: body as BodyInit } : {}),
    });
    if (response.headers.get("x-history-recording") === "INCOMPLETE")
      this.recordingIncomplete = true;
    if (!response.ok) {
      await response.body?.cancel();
      const error = new ClientError(response.status);
      const conversation = response.headers.get("x-history-conversation"),
        turn = response.headers.get("x-history-turn");
      if (isInputRef(conversation) && isInputRef(turn))
        error.history = {
          conversation,
          turn,
          recording:
            response.headers.get("x-history-recording") === "RECORDED"
              ? "RECORDED"
              : "INCOMPLETE",
        };
      throw error;
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ClientError();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        size += r.value.length;
        if (
          size >
          (path.startsWith("/api/v1/history/") ? 4 * 1024 * 1024 : 524288)
        )
          throw new ClientError();
        chunks.push(r.value);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    if (signal?.aborted) throw new ClientError();
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  }
  async historyRequest<T>(
    action: "query" | "conversation" | "feedback" | "review",
    value: unknown,
  ): Promise<T> {
    return (await this.request(
      `/api/v1/history/${action}`,
      "POST",
      JSON.stringify(value),
    )) as T;
  }
  async beginTurn(
    text: string,
    source: string,
    transcriptRef?: string,
    signal?: AbortSignal,
  ) {
    const v = await this.request(
      "/api/v1/input/turns",
      "POST",
      JSON.stringify({
        text,
        source,
        ...(transcriptRef ? { transcriptRef } : {}),
      }),
      signal,
    );
    if (
      !v ||
      typeof v !== "object" ||
      !("turn" in v) ||
      !("conversation" in v) ||
      !("recording" in v) ||
      !isInputRef(v.turn) ||
      !isInputRef(v.conversation) ||
      !["RECORDED", "INCOMPLETE"].includes(v.recording as string)
    )
      throw new ClientError();
    return v as import("@laita/contracts/browser").HistoryRef;
  }
  async unsubmitted(turn: string) {
    if (!isInputRef(turn)) throw new ClientError();
    await this.request(`/api/v1/input/turns/${turn}/unsubmitted`, "POST");
  }
  async observation(jobRef: string, runRef: string, event: string) {
    const v = await this.request(
      "/api/v1/input/observation",
      "POST",
      JSON.stringify({ jobRef, runRef, event }),
    );
    if (
      !v ||
      typeof v !== "object" ||
      !("recording" in v) ||
      v.recording !== "RECORDED"
    )
      throw new ClientError();
  }
  async start(signal?: AbortSignal) {
    const v = await this.request(
      "/api/v1/input/sessions",
      "POST",
      undefined,
      signal,
    );
    if (!isInputSession(v)) throw new ClientError();
    this.session = v.sessionRef;
    this.sequence = 0;
    return v;
  }
  async build(signal?: AbortSignal) {
    const v = await this.request(
      "/api/v1/input/build",
      "GET",
      undefined,
      signal,
    );
    if (!isInputBuild(v)) throw new ClientError();
    return v;
  }
  async choices(text: string, signal?: AbortSignal) {
    const v = await this.request(
      "/api/v1/input/choices",
      "POST",
      JSON.stringify({ text }),
      signal,
    );
    if (!isInputChoices(v)) throw new ClientError();
    return v;
  }
  async switchLocal(model: string, signal?: AbortSignal) {
    const v = await this.request(
      "/api/v1/input/model",
      "POST",
      JSON.stringify({ model }),
      signal,
    );
    if (
      !v ||
      typeof v !== "object" ||
      !("ok" in v) ||
      typeof v.ok !== "boolean" ||
      !("local" in v) ||
      !isLocalSelection(v.local)
    )
      throw new ClientError();
    return { ok: v.ok, local: v.local };
  }
  async submit(value: InputSubmission, signal?: AbortSignal) {
    const v = await this.request(
      "/api/v1/input/interactions",
      "POST",
      JSON.stringify(value),
      signal,
      { "x-input-sequence": String(++this.sequence) },
    );
    if (!isInputJob(v)) throw new ClientError();
    return v;
  }
  async upload(bytes: Uint8Array, signal?: AbortSignal) {
    const key = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    const v = await this.request(
      "/api/v1/input/transcriptions",
      "POST",
      bytes,
      signal,
      {
        "Content-Type": "audio/wav",
        "idempotency-key": key,
        "x-input-client": "COMPUTER",
        "x-input-sequence": String(++this.sequence),
        "x-input-consent": "press-to-talk",
      },
    );
    if (!isInputJob(v)) throw new ClientError();
    return v;
  }
  async synthesize(value: TtsSynthesisRequest, signal?: AbortSignal) {
    const v = await this.request(
      "/api/v1/input/synthesis",
      "POST",
      JSON.stringify(value),
      signal,
    );
    if (!isTtsMedia(v) && !isTtsSkipped(v)) throw new ClientError();
    return v;
  }
  async media(id: string, signal?: AbortSignal) {
    if (!isInputRef(id)) throw new ClientError();
    const timeout = AbortSignal.timeout(45_000);
    const response = await this.fetcher(`/api/v1/input/media/${id}`, {
      method: "GET",
      credentials: "same-origin",
      mode: "same-origin",
      redirect: "error",
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: {
        "x-owner-client": this.owner,
        "x-input-session": this.session,
      },
    });
    if (!response.ok || response.headers.get("content-type") !== "audio/wav") {
      await response.body?.cancel();
      throw new ClientError(response.status);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ClientError();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.length;
        if (size > 2 * 1024 * 1024) throw new ClientError();
        chunks.push(result.value);
      }
    } finally {
      await reader.cancel();
    }
    if (signal?.aborted || size < 44) throw new ClientError();
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      chunk.fill(0);
      offset += chunk.length;
    }
    return bytes;
  }
  async releaseMedia(id: string) {
    if (!isInputRef(id)) throw new ClientError();
    const response = await this.fetcher(`/api/v1/input/media/${id}`, {
      method: "DELETE",
      credentials: "same-origin",
      mode: "same-origin",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(45_000),
      headers: {
        "x-owner-client": this.owner,
        "x-input-session": this.session,
      },
    });
    if (response.status !== 204) {
      await response.body?.cancel();
      throw new ClientError(response.status);
    }
  }
  async job(id: string, signal?: AbortSignal) {
    if (!isInputRef(id)) throw new ClientError();
    const v = await this.request(
      `/api/v1/input/jobs/${id}`,
      "GET",
      undefined,
      signal,
    );
    if (!isInputJob(v) || v.jobRef !== id) throw new ClientError();
    return v;
  }
  async cancel(id: string) {
    if (!isInputRef(id)) throw new ClientError();
    const v = await this.request(`/api/v1/input/jobs/${id}`, "DELETE");
    if (!isInputJob(v) || v.jobRef !== id || v.state !== "CANCELLED")
      throw new ClientError();
  }
  async reset() {
    const old = this.session;
    this.session = "";
    if (old) {
      const v = await this.request(
        "/api/v1/input/session",
        "DELETE",
        undefined,
        undefined,
        { "x-input-session": old },
      );
      if (
        !v ||
        typeof v !== "object" ||
        !("contractVersion" in v) ||
        v.contractVersion !== "input-reset.v1" ||
        !("state" in v) ||
        v.state !== "RESET" ||
        !("cleanup" in v) ||
        !["NOT_REQUIRED", "PENDING"].includes(v.cleanup as string)
      )
        throw new ClientError();
    }
  }
}
