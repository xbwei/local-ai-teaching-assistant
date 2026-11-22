import {
  readAssignmentVerificationScope,
  readAssignmentVerificationResult,
  type AssignmentVerifier,
  canvasPageId,
  canvasPagePlanId,
  canvasPageTitle,
  canvasInventoryKinds,
  isCanvasInventoryKind,
  type CanvasInventory,
  type CanvasInventoryKind,
  canvasFeedbackSubmittedAt,
  readCanvasAssignmentDraft,
  readCanvasAssignmentScope,
  type CanvasAssignmentDraft,
  type CanvasAssignmentPreview,
  type CanvasAssignmentResult,
  readCanvasFeedbackDraft,
  readCanvasTestStudentScope,
  type CanvasFeedbackDraft,
  type CanvasFeedbackPreview,
  type CanvasFeedbackResult,
  readCanvasModuleDraft,
  readCanvasModuleScope,
  type CanvasModuleDraft,
  type CanvasModulePreview,
  type CanvasModuleResult,
  readCanvasPageDraft,
  sameCanvasPageDraft,
  type CanvasPageDraft,
  type CanvasPagePreview,
  type CanvasPageResult,
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
const responseRecord = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
type CanvasChatRouting = "direct" | "local";
const canvasChatRoute = (routing: CanvasChatRouting) =>
  routing === "local" ? "/api/v1/canvas/chat/tools" : "/api/v1/canvas/chat";

function readCanvasTarget(value: unknown): CanvasPagePreview["target"] {
  const target = responseRecord(value);
  if (
    !target ||
    typeof target.origin !== "string" ||
    target.origin.length > 512 ||
    new URL(target.origin).origin !== target.origin ||
    !target.origin.startsWith("https://") ||
    !canvasPageId(target.courseId) ||
    !canvasPageId(target.teacherId) ||
    !canvasPageTitle(target.courseName)
  )
    throw new ClientError();
  return {
    origin: target.origin,
    courseId: target.courseId,
    teacherId: target.teacherId,
    courseName: target.courseName,
  };
}

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
  async teacherDraft(
    course: string,
    kind: string,
    topic: string,
    signal: AbortSignal,
  ): Promise<
    | { code: string }
    | { text: string; sources: { path: string; section: string }[] }
  > {
    const value = await this.request(
      "/api/v1/teacher-draft",
      "POST",
      JSON.stringify({ course, kind, topic }),
      signal,
    );
    if (value && typeof value === "object") {
      if ("code" in value && typeof value.code === "string")
        return { code: value.code };
      if (
        "text" in value &&
        typeof value.text === "string" &&
        "sources" in value &&
        Array.isArray(value.sources) &&
        value.sources.every(
          (source: unknown) =>
            source &&
            typeof source === "object" &&
            "path" in source &&
            typeof source.path === "string" &&
            "section" in source &&
            typeof source.section === "string",
        )
      )
        return {
          text: value.text,
          sources: value.sources as { path: string; section: string }[],
        };
    }
    throw new ClientError();
  }
  async canvasPagesEnabled() {
    const value = await this.request("/api/v1/canvas/pages", "GET");
    return responseRecord(value)?.enabled === true;
  }
  async previewCanvasPage(
    draft: CanvasPageDraft,
    signal: AbortSignal,
  ): Promise<CanvasPagePreview> {
    const value = responseRecord(
      await this.request(
        "/api/v1/canvas/pages/preview",
        "POST",
        JSON.stringify({ draft }),
        signal,
      ),
    );
    const target = readCanvasTarget(value?.target);
    const returnedDraft = responseRecord(value?.draft);
    if (
      !canvasPagePlanId(value?.planId) ||
      !sameCanvasPageDraft(readCanvasPageDraft(returnedDraft), draft) ||
      returnedDraft?.body !== draft.body
    )
      throw new ClientError();
    return {
      planId: value.planId,
      target,
      draft,
    };
  }
  async createCanvasPage(
    preview: CanvasPagePreview,
    signal: AbortSignal,
  ): Promise<CanvasPageResult> {
    const { planId, draft } = preview;
    const value = responseRecord(
      await this.request(
        "/api/v1/canvas/pages/create",
        "POST",
        JSON.stringify({ confirm: true, planId, draft }),
        signal,
      ),
    );
    if (value?.status === "UNCERTAIN") return { status: "UNCERTAIN" };
    if (
      (value?.status === "VERIFIED" || value?.status === "UNVERIFIED") &&
      canvasPageId(value.pageId)
    )
      return { status: value.status, pageId: value.pageId };
    throw new ClientError();
  }
  async canvasAssignmentScope() {
    return readCanvasAssignmentScope(
      await this.request("/api/v1/canvas/assignments", "GET"),
    );
  }

  async canvasInventoryOptions() {
    const value = responseRecord(
      await this.request("/api/v1/canvas/inventory", "GET"),
    );
    const kinds = value?.kinds;
    if (
      !Array.isArray(kinds) ||
      kinds.length > canvasInventoryKinds.length ||
      !kinds.every(isCanvasInventoryKind) ||
      new Set(kinds).size !== kinds.length
    )
      throw new ClientError();
    return kinds;
  }

  async canvasInventory(
    kind: CanvasInventoryKind,
    signal: AbortSignal,
  ): Promise<CanvasInventory> {
    const value = responseRecord(
      await this.request(
        `/api/v1/canvas/inventory/${encodeURIComponent(kind)}`,
        "GET",
        undefined,
        signal,
      ),
    );
    const target = readCanvasTarget(value?.target);
    if (
      !Array.isArray(value?.entries) ||
      value.entries.length < 1 ||
      value.entries.length > 12
    )
      throw new ClientError();
    const entries = value.entries.map((entry: unknown) => {
      const item = responseRecord(entry);
      if (
        !canvasPageId(item?.id) ||
        !canvasPageTitle(item?.title) ||
        typeof item?.published !== "boolean"
      )
        throw new ClientError();
      return { id: item.id, title: item.title, published: item.published };
    });
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
      throw new ClientError();
    return { target, entries };
  }

  async previewCanvasAssignment(
    draft: CanvasAssignmentDraft,
    signal: AbortSignal,
  ): Promise<CanvasAssignmentPreview> {
    const value = responseRecord(
      await this.request(
        "/api/v1/canvas/assignments/preview",
        "POST",
        JSON.stringify({ draft }),
        signal,
      ),
    );
    const target = readCanvasTarget(value?.target);
    const subject = responseRecord(value?.subject);
    if (
      !canvasPagePlanId(value?.planId) ||
      !subject ||
      subject.kind !== draft.kind ||
      !canvasPageId(subject.id) ||
      !canvasPageTitle(subject.name) ||
      JSON.stringify(readCanvasAssignmentDraft(value.draft)) !==
        JSON.stringify(draft) ||
      (draft.kind === "CREATE" &&
        responseRecord(value.draft)?.body !== draft.body)
    )
      throw new ClientError();
    if (draft.kind === "TITLE") {
      if (
        subject.id !== draft.assignmentId ||
        typeof subject.updatedAt !== "string" ||
        !Number.isFinite(Date.parse(subject.updatedAt)) ||
        typeof subject.published !== "boolean"
      )
        throw new ClientError();
      return {
        planId: value.planId,
        target,
        draft,
        subject: {
          kind: "TITLE",
          id: subject.id,
          name: subject.name,
          updatedAt: subject.updatedAt,
          published: subject.published,
        },
      };
    }
    return {
      planId: value.planId,
      target,
      draft,
      subject: {
        kind: "CREATE",
        id: subject.id,
        name: subject.name,
      },
    };
  }

  async saveCanvasAssignment(
    preview: CanvasAssignmentPreview,
    signal: AbortSignal,
  ): Promise<CanvasAssignmentResult> {
    const { planId, draft } = preview;
    const value = responseRecord(
      await this.request(
        "/api/v1/canvas/assignments/save",
        "POST",
        JSON.stringify({ confirm: true, planId, draft }),
        signal,
      ),
    );
    if (value?.status === "UNCERTAIN") return { status: "UNCERTAIN" };
    if (
      (value?.status === "VERIFIED" || value?.status === "UNVERIFIED") &&
      canvasPageId(value.assignmentId)
    )
      return { status: value.status, assignmentId: value.assignmentId };
    throw new ClientError();
  }

  async canvasModuleScope() {
    return readCanvasModuleScope(
      await this.request("/api/v1/canvas/modules", "GET"),
    );
  }

  async previewCanvasModule(
    draft: CanvasModuleDraft,
    signal: AbortSignal,
  ): Promise<CanvasModulePreview> {
    const value = responseRecord(
      await this.request(
        "/api/v1/canvas/modules/preview",
        "POST",
        JSON.stringify({ draft }),
        signal,
      ),
    );
    const target = readCanvasTarget(value?.target);
    if (
      !canvasPagePlanId(value?.planId) ||
      JSON.stringify(readCanvasModuleDraft(value.draft)) !==
        JSON.stringify(draft)
    )
      throw new ClientError();
    const plan = { planId: value.planId, target, draft };
    if (draft.kind === "CREATE_MODULE") {
      if (value.moduleSubject !== undefined) throw new ClientError();
      return plan;
    }
    const subject = responseRecord(value.moduleSubject);
    if (
      !subject ||
      subject.moduleId !== draft.moduleId ||
      !canvasPageTitle(subject.moduleName) ||
      !canvasPageTitle(subject.resourceName) ||
      typeof subject.resourcePublished !== "boolean"
    )
      throw new ClientError();
    return {
      ...plan,
      moduleSubject: {
        moduleId: draft.moduleId,
        moduleName: subject.moduleName,
        resourceName: subject.resourceName,
        resourcePublished: subject.resourcePublished,
      },
    };
  }

  async saveCanvasModule(
    preview: CanvasModulePreview,
    signal: AbortSignal,
  ): Promise<CanvasModuleResult> {
    const { planId, draft } = preview;
    const value = responseRecord(
      await this.request(
        "/api/v1/canvas/modules/save",
        "POST",
        JSON.stringify({ confirm: true, planId, draft }),
        signal,
      ),
    );
    if (value?.status === "UNCERTAIN") return { status: "UNCERTAIN" };
    if (
      (value?.status === "VERIFIED" || value?.status === "UNVERIFIED") &&
      canvasPageId(value.resourceId)
    )
      return { status: value.status, resourceId: value.resourceId };
    throw new ClientError();
  }

  async canvasFeedbackScope() {
    return readCanvasTestStudentScope(
      await this.request("/api/v1/canvas/feedback", "GET"),
    );
  }

  async previewCanvasFeedback(
    draft: CanvasFeedbackDraft,
    testStudentId: string,
    signal: AbortSignal,
  ): Promise<CanvasFeedbackPreview> {
    const value = responseRecord(
      await this.request(
        "/api/v1/canvas/feedback/preview",
        "POST",
        JSON.stringify({ draft }),
        signal,
      ),
    );
    const target = readCanvasTarget(value?.target);
    const subject = responseRecord(value?.feedbackSubject);
    if (
      !canvasPagePlanId(value?.planId) ||
      JSON.stringify(readCanvasFeedbackDraft(value.draft)) !==
        JSON.stringify(draft) ||
      !subject ||
      subject.testStudentId !== testStudentId ||
      !canvasPageTitle(subject.assignmentName) ||
      typeof subject.attempt !== "number" ||
      !Number.isSafeInteger(subject.attempt) ||
      subject.attempt < 1 ||
      !canvasFeedbackSubmittedAt(subject.submittedAt)
    )
      throw new ClientError();
    return {
      planId: value.planId,
      target,
      draft,
      feedbackSubject: {
        testStudentId,
        assignmentName: subject.assignmentName,
        attempt: subject.attempt,
        submittedAt: subject.submittedAt,
      },
    };
  }

  async postCanvasFeedback(
    preview: CanvasFeedbackPreview,
    signal: AbortSignal,
  ): Promise<CanvasFeedbackResult> {
    const { planId, draft } = preview;
    const value = responseRecord(
      await this.request(
        "/api/v1/canvas/feedback/post",
        "POST",
        JSON.stringify({ confirm: true, planId, draft }),
        signal,
      ),
    );
    if (value?.status === "UNCERTAIN") return { status: "UNCERTAIN" };
    if (
      (value?.status === "VERIFIED" || value?.status === "UNVERIFIED") &&
      canvasPageId(value.commentId)
    )
      return { status: value.status, commentId: value.commentId };
    throw new ClientError();
  }

  async canvasChatEnabled(routing: CanvasChatRouting = "direct") {
    return (
      responseRecord(await this.request(canvasChatRoute(routing), "GET"))
        ?.enabled === true
    );
  }

  async canvasVerificationScope() {
    return readAssignmentVerificationScope(
      await this.request("/api/v1/canvas/verification", "GET"),
    );
  }

  async verifyCanvasSubmission(
    scope: string,
    assignmentId: string,
    provider: AssignmentVerifier,
    studentId: string,
    signal: AbortSignal,
  ) {
    return readAssignmentVerificationResult(
      await this.request(
        "/api/v1/canvas/verification",
        "POST",
        JSON.stringify({ scope, assignmentId, provider, studentId }),
        signal,
      ),
    );
  }

  async canvasChat(
    question: string,
    signal: AbortSignal,
    routing: CanvasChatRouting = "direct",
  ) {
    const value = responseRecord(
      await this.request(
        canvasChatRoute(routing),
        "POST",
        JSON.stringify({ question }),
        signal,
      ),
    );
    if (typeof value?.text === "string" && value.text.length <= 512)
      return value.text;
    throw new ClientError();
  }

  async teacherHistoryEnabled() {
    const value = await this.request("/api/v1/teacher-tools/history", "GET");
    return (
      !!value &&
      typeof value === "object" &&
      "enabled" in value &&
      value.enabled === true
    );
  }
  async teacherHistory(question: string, signal: AbortSignal) {
    const value = await this.request(
      "/api/v1/teacher-tools/history",
      "POST",
      JSON.stringify({ question }),
      signal,
    );
    if (
      value &&
      typeof value === "object" &&
      "text" in value &&
      typeof value.text === "string"
    )
      return value.text;
    throw new ClientError();
  }
  async historyRequest<T>(
    action: "query" | "conversation" | "feedback" | "review" | "diagnostic",
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
