import {
  providerMessages,
  reservedProviderInput,
  reviewedPolicyRuntimeContract,
} from "@laita/contracts";
import { randomUUID } from "node:crypto";
import type {
  Trace,
  CourseGrounding,
  ProviderRunRequest,
  ProviderRunResult,
} from "@laita/contracts";
import {
  courseGroundingInstruction,
  courseEvidencePrompt,
  identifyCourseQuestion,
  type CourseGroundingResult,
} from "@laita/course-grounding";

type Evidence = {
  readonly systemInstruction: string;
  readonly prompt: string;
  readonly refs: readonly string[];
};
type ExecuteProvider = (
  request: ProviderRunRequest,
  signal: AbortSignal,
  sessionRef: `session-${string}`,
  evidence?: Evidence,
  trace?: Trace,
) => Promise<ProviderRunResult>;

export const coursePreparationDeadlineMs = 30_000;

export class CoursePreparationError extends Error {
  readonly outcome: "TIMEOUT" | "CANCELLED";
  constructor(outcome: "TIMEOUT" | "CANCELLED") {
    super(`Course preparation ${outcome}`);
    this.outcome = outcome;
  }
}

const interactionRef = (): `interaction-${string}` =>
  `interaction-${randomUUID()}`;

function notice(
  request: ProviderRunRequest,
  grounding: CourseGrounding,
): ProviderRunResult {
  return {
    contractVersion: "provider-run-result.v1",
    interactionRef: interactionRef(),
    mode: request.mode,
    legs: [],
    grounding,
  };
}

export function createCourseAwareExecution(options: {
  readonly grounder: {
    ground(
      question: string,
      signal: AbortSignal,
      trace?: Trace,
      source?: "TYPED" | "TRANSCRIPT",
    ): Promise<CourseGroundingResult>;
  };
  readonly executeProvider: ExecuteProvider;
  readonly preparationMs?: number;
}) {
  const preparationMs = options.preparationMs ?? coursePreparationDeadlineMs;
  if (
    !Number.isSafeInteger(preparationMs) ||
    preparationMs < 1 ||
    preparationMs > coursePreparationDeadlineMs
  )
    throw new Error("Invalid course preparation deadline");
  return async function execute(
    request: ProviderRunRequest,
    signal: AbortSignal,
    sessionRef: `session-${string}`,
    trace?: Trace,
    source: "TYPED" | "TRANSCRIPT" = "TYPED",
  ): Promise<ProviderRunResult> {
    const executeProvider: typeof options.executeProvider = async (...args) => {
      const started = Date.now();
      trace?.("PROVIDER", "REQUESTED");
      try {
        const result = await options.executeProvider(
          args[0],
          args[1],
          args[2],
          args[3],
          trace,
        );
        trace?.("PROVIDER", "RETURNED", Date.now() - started);
        return result;
      } catch (error) {
        trace?.(
          "PROVIDER",
          signal.aborted ? "CANCELLED" : "FAILED",
          Date.now() - started,
        );
        throw error;
      }
    };
    const identified = identifyCourseQuestion(request.input.text, source);
    if (
      source === "TRANSCRIPT" &&
      identified !== identifyCourseQuestion(request.input.text)
    )
      trace?.("COURSE", "TRANSCRIPT_ALIAS_RECOVERED");
    trace?.("COURSE", identified ?? "NOT_APPLICABLE", undefined, {
      course: identified && identified !== "AMBIGUOUS" ? identified : null,
      lab: null,
      sources: [],
    });
    if (!identified) {
      trace?.("RETRIEVAL", "NOT_APPLICABLE");
      return executeProvider(request, signal, sessionRef);
    }
    if (identified === "AMBIGUOUS") {
      trace?.("RETRIEVAL", "NOT_EXECUTED");
      trace?.("PROVIDER", "NOT_EXECUTED");
      return notice(request, { status: "EVIDENCE_AMBIGUOUS" });
    }
    if (request.mode !== "LOCAL") {
      trace?.("RETRIEVAL", "NOT_EXECUTED");
      trace?.("PROVIDER", "NOT_EXECUTED");
      return notice(request, { status: "LOCAL_ONLY", course: identified });
    }

    const controller = new AbortController();
    const started = performance.now();
    const cancel = () =>
      controller.abort(new CoursePreparationError("CANCELLED"));
    const timeout = () =>
      controller.abort(new CoursePreparationError("TIMEOUT"));
    signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(timeout, preparationMs);
    let grounding: CourseGroundingResult;
    try {
      if (signal.aborted) cancel();
      controller.signal.throwIfAborted();
      // Await settlement, including refresh/body cleanup. A detached race would
      // release admission while the cancelled preparation still owns resources.
      grounding = await options.grounder.ground(
        request.input.text,
        controller.signal,
        trace,
        source,
      );
      if (performance.now() - started >= preparationMs) timeout();
      controller.signal.throwIfAborted();
    } catch (error) {
      if (controller.signal.aborted) {
        const failure = controller.signal.reason as CoursePreparationError;
        trace?.("RETRIEVAL", failure.outcome, performance.now() - started);
        trace?.("PROVIDER", "NOT_EXECUTED");
        throw failure;
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
    }
    trace?.("RETRIEVAL", grounding.status, undefined, {
      course: identified,
      lab: null,
      sources: [],
    });
    if (grounding.status === "ORDINARY")
      return executeProvider(request, signal, sessionRef);
    if (grounding.status !== "FOUND") {
      trace?.("PROVIDER", "NOT_EXECUTED");
      const status = {
        UNAVAILABLE: "SOURCES_UNAVAILABLE",
        MISSING: "EVIDENCE_NOT_FOUND",
        AMBIGUOUS: "EVIDENCE_AMBIGUOUS",
        CONFLICTING: "EVIDENCE_CONFLICTING",
      }[grounding.status] as Exclude<
        CourseGrounding["status"],
        "GROUNDED" | "LOCAL_ONLY" | "EVIDENCE_INPUT_LIMIT"
      >;
      return notice(request, {
        status,
        course: identified,
      });
    }
    let fittedRequest = request;
    const firstEvidence = {
      systemInstruction: courseGroundingInstruction,
      prompt: courseEvidencePrompt(grounding.sources.slice(0, 1)),
    };
    const inputLimit =
      reviewedPolicyRuntimeContract.successor.limits.maxInputTokensPerProvider;
    const fits = (evidence: { systemInstruction: string; prompt: string }) =>
      reservedProviderInput(
        providerMessages(fittedRequest.input, "LOCAL", evidence),
      ) <= inputLimit;
    // Match the browser's existing unit: a USER and every following assistant
    // leg up to the next USER. Never split a message or mutate retained history.
    while (
      grounding.sources.length &&
      !fits(firstEvidence) &&
      fittedRequest.input.history?.length
    ) {
      const history = fittedRequest.input.history;
      const nextTurn = history.findIndex((m, i) => i > 0 && m.role === "USER");
      fittedRequest = {
        ...request,
        input: {
          ...request.input,
          history: history.slice(nextTurn < 0 ? history.length : nextTurn),
        },
      };
      trace?.("RETRIEVAL", "CONTEXT_REDUCED");
    }
    const sources = [] as (typeof grounding.sources)[number][];
    for (const source of grounding.sources) {
      const candidate = [...sources, source];
      if (
        !fits({
          systemInstruction: courseGroundingInstruction,
          prompt: courseEvidencePrompt(candidate),
        })
      )
        break;
      sources.push(source);
    }
    if (!sources.length) {
      trace?.("RETRIEVAL", "EVIDENCE_INPUT_LIMIT");
      trace?.("PROVIDER", "NOT_EXECUTED");
      return notice(request, {
        status: "EVIDENCE_INPUT_LIMIT",
        course: grounding.course,
      });
    }
    trace?.("RETRIEVAL", "SOURCES_SELECTED", undefined, {
      course: grounding.course,
      lab: null,
      sources,
    });
    const result = await executeProvider(fittedRequest, signal, sessionRef, {
      systemInstruction: courseGroundingInstruction,
      prompt: courseEvidencePrompt(sources),
      refs: sources.map((_, index) => `course-source-${index + 1}`),
    });
    return {
      ...result,
      grounding: {
        status: "GROUNDED",
        course: grounding.course,
        snapshot: grounding.snapshot,
        sources,
      },
    };
  };
}
