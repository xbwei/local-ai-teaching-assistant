import { randomBytes } from "node:crypto";
import express, { type Express, type Request, type Response } from "express";
import {
  HistoryValidationError,
  type HistoryRepository,
} from "@laita/persistence";
import {
  isInputRef,
  type HistoryRef,
  type HistoryStage,
  type HistoryOutcome,
  type ProviderRunResult,
  type HistoryFilter,
  type HistorySnapshot,
  type HistorySource,
} from "@laita/contracts";
import { classifyInput } from "@laita/safety";

export function createHistoryCapture(
  store: HistoryRepository | undefined,
  conversation: string,
  inputType: "TYPED" | "VOICE",
  text: string | null,
  correlation: string | null,
) {
  const ref: HistoryRef = {
    conversation,
    turn: randomBytes(32).toString("hex"),
    recording: "RECORDED",
  };
  const write = (fn: (db: HistoryRepository) => void) => {
    try {
      if (!store) throw new Error();
      fn(store);
    } catch {
      ref.recording = "INCOMPLETE";
      try {
        store?.incomplete(ref.turn);
      } catch {
        /* The response remains INCOMPLETE even if the disk cannot record it. */
      }
    }
  };
  write((db) =>
    db.begin({ id: ref.turn, conversation, inputType, text, correlation }),
  );
  const event = (
    stage: HistoryStage,
    outcome: string,
    durationMs?: number,
    leg?: string,
    origin: "SERVER" | "BROWSER" = "SERVER",
    snapshot?: HistorySnapshot,
  ) =>
    write((db) =>
      db.event(ref.turn, {
        stage,
        outcome,
        at: new Date().toISOString(),
        origin,
        ...(snapshot ? { snapshot } : {}),
        ...(durationMs === undefined
          ? {}
          : { durationMs: Math.max(0, Math.round(durationMs)) }),
        ...(leg ? { leg } : {}),
      }),
    );
  return {
    ref,
    event,
    text(value: string) {
      write((db) => db.text(ref.turn, value));
    },
    outcome(value: HistoryOutcome) {
      write((db) => db.outcome(ref.turn, value));
    },
    safety() {
      write((db) => db.safety(ref.turn));
    },
    source(
      course: string | null,
      lab: string | null,
      sources: HistorySource[],
    ) {
      write((db) => db.source(ref.turn, course, lab, sources));
    },
    result(value: ProviderRunResult, cancelled = false) {
      const completed = value.legs.filter(
        (l) => l.status === "COMPLETED",
      ).length;
      const outcome = cancelled
        ? "CANCELLED"
        : !value.legs.length
          ? "NO_ANSWER"
          : completed === value.legs.length
            ? "SUCCESS"
            : completed
              ? "PARTIAL"
              : value.legs.some((l) => l.failure?.code === "TIMEOUT")
                ? "TIMEOUT"
                : value.legs.every((l) => l.status === "CANCELLED")
                  ? "CANCELLED"
                  : "FAILED";
      write((db) =>
        db.result(
          ref.turn,
          value.interactionRef,
          value.legs.map((l) => ({
            leg: l.runRef,
            provider: l.provider,
            model: l.model,
            actualProvider: l.provenance?.actualProvider ?? null,
            actualModel: l.provenance?.actualModel ?? null,
            status: cancelled ? "CANCELLED" : l.status,
            text: cancelled ? null : (l.output?.text ?? null),
            failure: cancelled ? "CANCELLED" : (l.failure?.code ?? null),
            latencyMs: l.metrics.latencyMs,
          })),
          outcome,
        ),
      );
      for (const leg of value.legs)
        event(
          "ANSWER",
          cancelled
            ? "CANCELLED_RESULT_NOT_DISPLAYED"
            : (leg.failure?.code ?? leg.status),
          leg.metrics.latencyMs,
          leg.runRef,
        );
      if (!value.legs.length)
        event("ANSWER", value.grounding?.status ?? "NO_ANSWER");
    },
  };
}
export type HistoryCapture = ReturnType<typeof createHistoryCapture>;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const boundedText = (v: unknown, max = 2000) =>
  typeof v === "string" && v.length <= max && (!v.trim() || !!classifyInput(v));
const integer = (v: unknown) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
export function installHistoryRoutes(
  app: Express,
  store: HistoryRepository,
  authenticate: (req: Request, res: Response) => unknown,
) {
  app.use("/api/v1/history", (req, res, next) => {
    if (authenticate(req, res)) next();
  });
  const parse = express.json({ limit: 16384, inflate: false, strict: true });
  app.use("/api/v1/history", (req, res, next) => {
    parse(req, res, (error: unknown) => {
      if (error) {
        res.status(400).json({ code: "INVALID_REQUEST" });
        return;
      }
      next();
    });
  });
  const route = (
    path: string,
    work: (body: Record<string, unknown>) => unknown,
  ) =>
    app.post(`/api/v1/history/${path}`, (req, res) => {
      if (!req.is("json") || !object(req.body)) {
        res.status(400).json({ code: "INVALID_REQUEST" });
        return;
      }
      try {
        res.json(work(req.body));
      } catch (error) {
        if (error instanceof HistoryValidationError) {
          res.status(400).json({ code: "INVALID_REQUEST" });
          return;
        }
        res
          .status(503)
          .json({ code: "HISTORY_UNAVAILABLE", recording: "INCOMPLETE" });
      }
    });
  const exact = (v: Record<string, unknown>, keys: string[]) => {
    if (Object.keys(v).some((k) => !keys.includes(k)))
      throw new HistoryValidationError();
  };
  route("query", (v) => {
    exact(v, [
      "before",
      "limit",
      "search",
      "inputType",
      "course",
      "lab",
      "provider",
      "model",
      "outcome",
      "feedback",
      "review",
      "problems",
      "suspected",
      "since",
      "until",
    ]);
    if (
      (v.before !== undefined && !integer(v.before)) ||
      (v.limit !== undefined &&
        (!integer(v.limit) || Number(v.limit) < 1 || Number(v.limit) > 50))
    )
      throw new HistoryValidationError();
    for (const k of ["search", "lab", "model"])
      if (
        v[k] !== undefined &&
        (typeof v[k] !== "string" || (v[k] as string).length > 200)
      )
        throw new HistoryValidationError();
    for (const [key, values] of Object.entries({
      inputType: ["TYPED", "VOICE"],
      course: ["IA340", "IA342"],
      provider: ["LOCAL", "OPENAI"],
      outcome: [
        "PENDING",
        "TRANSCRIBED",
        "SUCCESS",
        "PARTIAL",
        "FAILED",
        "TIMEOUT",
        "CANCELLED",
        "NO_ANSWER",
        "INTERRUPTED",
      ],
      feedback: ["HELPFUL", "NOT_HELPFUL", "REPORT"],
      review: ["PENDING", "REVIEWED", "CONFIRMED_ISSUE", "NO_ISSUE"],
    }))
      if (v[key] !== undefined && !values.includes(v[key] as string))
        throw new HistoryValidationError();
    for (const key of ["since", "until"])
      if (
        v[key] !== undefined &&
        (typeof v[key] !== "string" ||
          !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(v[key] as string) ||
          !Number.isFinite(Date.parse(v[key] as string)))
      )
        throw new HistoryValidationError();
    if (v.suspected !== undefined && typeof v.suspected !== "boolean")
      throw new HistoryValidationError();
    if (v.problems !== undefined && typeof v.problems !== "boolean")
      throw new HistoryValidationError();
    return store.list(v as HistoryFilter);
  });
  route("conversation", (v) => {
    exact(v, ["conversation", "after"]);
    if (
      !isInputRef(v.conversation) ||
      (v.after !== undefined && !integer(v.after))
    )
      throw new HistoryValidationError();
    return store.conversation(v.conversation, v.after as number | undefined);
  });
  route("feedback", (v) => {
    exact(v, ["conversation", "turn", "leg", "vote", "report", "reason"]);
    if (
      !isInputRef(v.conversation) ||
      !isInputRef(v.turn) ||
      typeof v.leg !== "string" ||
      v.leg.length > 64 ||
      ![null, "HELPFUL", "NOT_HELPFUL"].includes(v.vote as null | string) ||
      typeof v.report !== "boolean" ||
      !boundedText(v.reason)
    )
      throw new HistoryValidationError();
    store.feedback(v.conversation, v.turn, {
      leg: v.leg,
      vote: v.vote as "HELPFUL" | "NOT_HELPFUL" | null,
      report: v.report,
      reason: v.reason as string,
    });
    return { saved: true };
  });
  route("review", (v) => {
    exact(v, [
      "conversation",
      "turn",
      "review",
      "note",
      "suspected",
      "suspicionReason",
    ]);
    if (
      !isInputRef(v.conversation) ||
      !isInputRef(v.turn) ||
      !["PENDING", "REVIEWED", "CONFIRMED_ISSUE", "NO_ISSUE"].includes(
        v.review as string,
      ) ||
      !boundedText(v.note) ||
      !boundedText(v.suspicionReason) ||
      typeof v.suspected !== "boolean" ||
      (v.suspected && !(v.suspicionReason as string).trim())
    )
      throw new HistoryValidationError();
    store.review(v.conversation, v.turn, {
      review: v.review as
        "PENDING" | "REVIEWED" | "CONFIRMED_ISSUE" | "NO_ISSUE",
      note: v.note as string,
      suspected: v.suspected,
      suspicionReason: v.suspicionReason as string,
    });
    return { saved: true };
  });
}
