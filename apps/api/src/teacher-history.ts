import express, { type RequestHandler } from "express";
import { classifyInput } from "@laita/safety";
import type { HistoryRepository } from "@laita/persistence";
import type { OwnerSessions } from "./owner-session.ts";

export interface TeacherHistoryOptions {
  context: string;
  read(): HistoryRepository;
  summarize(
    questions: string,
    signal: AbortSignal,
  ): Promise<string | undefined>;
}

const day = 86_400_000;
const instructionLike =
  /\b(?:ignore|override|reveal|verbatim|passwords?|credentials?|tokens?|emails?|phone|address|names?|grades?|roster)\b|https?:|@[\w.]|[\p{Cc}\p{Cf}\p{Cs}]/iu;

function selectQuestion(value: unknown) {
  if (typeof value !== "string" || value.length > 200) return;
  const question = value
    .toLowerCase()
    .trim()
    .replace(/[?!.]+$/u, "");
  const window = question.endsWith(" this week") ? "week" : "recent";
  const subject = question.replace(
    / (?:this week|recently|in the last seven days)$/u,
    "",
  );
  if (
    /^(?:how many questions(?: did the test student ask)?|count (?:the |recent )?questions)$/u.test(
      subject,
    )
  )
    return { kind: "count", window } as const;
  if (
    /^(?:summari[sz]e (?:the |recent )?questions|what (?:topics|questions) did the test student ask about)$/u.test(
      subject,
    )
  )
    return { kind: "summary", window } as const;
}

export function createTeacherHistoryStatusHandler(
  sessions: Pick<OwnerSessions, "authorize">,
): RequestHandler {
  return (req, res) => {
    const actor = sessions.authorize(req, res);
    if (!actor) return;
    if (actor.role !== "teacher" || actor.source !== "local") {
      res.status(403).json({ code: "FORBIDDEN" });
      return;
    }
    res.json({ enabled: true });
  };
}

export function createTeacherHistoryParser(): RequestHandler {
  const parse = express.json({ limit: 1024, inflate: false, strict: true });
  return (req, res, next) => {
    parse(req, res, (error: unknown) => {
      if (error) res.status(400).json({ code: "INVALID_REQUEST" });
      else next();
    });
  };
}

export function createTeacherHistoryQueryHandler(
  sessions: Pick<OwnerSessions, "authorize" | "isCurrent">,
  options: TeacherHistoryOptions,
): RequestHandler {
  return async (req, res) => {
    const actor = sessions.authorize(req, res);
    if (!actor) return;
    if (actor.role !== "teacher" || actor.source !== "local") {
      res.status(403).json({ code: "FORBIDDEN" });
      return;
    }
    if (
      !req.is("json") ||
      !req.body ||
      Object.keys(req.body).join(",") !== "question"
    ) {
      res.status(400).json({ code: "INVALID_REQUEST" });
      return;
    }
    const selection = selectQuestion(req.body.question);
    if (!selection) {
      res.json({
        text: "Ask for the Test Student’s recent question count or a summary. The plugin covers one local sample.",
      });
      return;
    }
    const now = new Date();
    const monday =
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
      ((now.getUTCDay() + 6) % 7) * day;
    const since = new Date(
      selection.window === "week" ? monday : now.getTime() - 7 * day,
    );
    const controller = new AbortController();
    const disconnect = () => controller.abort();
    res.once("close", disconnect);
    try {
      const sample = options
        .read()
        .sampleQuestions(
          since.toISOString(),
          now.toISOString(),
          selection.kind === "summary",
        );
      let text: string;
      if (selection.kind === "count") {
        text = `${sample.partial ? "At least " : ""}${sample.count} ${sample.count === 1 ? "question" : "questions"} recorded for the Test Student sample from ${since.toISOString().slice(0, 10)} UTC through now.`;
      } else {
        const questions: string[] = [];
        for (const raw of sample.questions) {
          const question = raw.trim().replace(/\s+/gu, " ");
          if (!classifyInput(question) || instructionLike.test(question))
            continue;
          if (
            Buffer.byteLength(JSON.stringify([...questions, question])) > 2048
          )
            break;
          questions.push(question);
        }
        const result = questions.length
          ? await options.summarize(
              JSON.stringify(questions),
              controller.signal,
            )
          : undefined;
        text =
          result?.trim() &&
          Buffer.byteLength(result) <= 512 &&
          !instructionLike.test(result)
            ? result.trim()
            : questions.length
              ? "The Local summary is unavailable. The count is still available."
              : sample.count
                ? "There are no eligible questions for a summary in this window."
                : "No questions were recorded for the Test Student sample in this window.";
      }
      if (!controller.signal.aborted) {
        if (sessions.isCurrent(req, actor.binding)) res.json({ text });
        else res.status(401).json({ code: "UNAUTHENTICATED" });
      }
    } catch {
      if (!controller.signal.aborted)
        res.status(503).json({ code: "HISTORY_UNAVAILABLE" });
    } finally {
      res.off("close", disconnect);
    }
  };
}
