import express, { type RequestHandler } from "express";
import { classifyInput } from "@laita/safety";
import { courseIds, type CourseId } from "@laita/course-grounding";
import { validCourseGrounding, type ProviderRunResult } from "@laita/contracts";
import type { OwnerSessions } from "./owner-session.ts";

export type TeacherDraft = (
  course: CourseId,
  kind: "PAGE" | "ASSIGNMENT",
  topic: string,
  signal: AbortSignal,
  includeCriteria: boolean,
) => Promise<ProviderRunResult | undefined>;

export function createTeacherDraftParser(): RequestHandler {
  const parse = express.json({ limit: 2048, inflate: false, strict: true });
  return (req, res, next) => {
    parse(req, res, (error: unknown) => {
      if (error) res.status(400).json({ code: "INVALID_REQUEST" });
      else next();
    });
  };
}

export function createTeacherDraftHandler(
  sessions: Pick<OwnerSessions, "authorize" | "isCurrent">,
  generate: TeacherDraft,
): RequestHandler {
  return async (req, res) => {
    const actor = sessions.authorize(req, res);
    if (!actor) return;
    // Canvas drafting requires the course bound by the signed launch and the
    // current membership. A legacy launch has no approved public course.
    const boundCourse = actor.demo?.course;
    if (
      actor.role !== "teacher" ||
      (actor.source === "canvas" && !boundCourse)
    ) {
      res.status(403).json({ code: "FORBIDDEN" });
      return;
    }
    const value = req.body;
    const keys = value && Object.keys(value).sort().join(",");
    if (
      !req.is("json") ||
      (keys !== "course,kind,topic" &&
        (keys !== "course,includeCriteria,kind,topic" ||
          value.kind !== "ASSIGNMENT" ||
          typeof value.includeCriteria !== "boolean")) ||
      !courseIds.includes(value.course) ||
      (value.kind !== "PAGE" && value.kind !== "ASSIGNMENT") ||
      typeof value.topic !== "string" ||
      Buffer.byteLength(value.topic) > 512 ||
      !classifyInput(value.topic)
    ) {
      res.status(400).json({ code: "INVALID_REQUEST" });
      return;
    }
    if (boundCourse && value.course !== boundCourse) {
      res.status(403).json({ code: "FORBIDDEN" });
      return;
    }
    const controller = new AbortController();
    const disconnect = () => controller.abort();
    res.once("close", disconnect);
    try {
      const result = await generate(
        value.course,
        value.kind,
        value.topic,
        controller.signal,
        value.includeCriteria === true,
      );
      if (controller.signal.aborted) return;
      if (!sessions.isCurrent(req, actor.binding)) {
        res.status(401).json({ code: "UNAUTHENTICATED" });
        return;
      }
      const leg = result?.legs[0];
      const grounding = result?.grounding;
      if (
        result?.mode === "LOCAL" &&
        grounding?.status === "GROUNDED" &&
        grounding.course === value.course &&
        validCourseGrounding(grounding) &&
        leg?.status === "COMPLETED" &&
        leg.provider === "LOCAL" &&
        leg.provenance?.actualProvider === "LOCAL" &&
        leg.output?.text.trim()
      ) {
        res.json({
          text: leg.output.text,
          sources: grounding.sources.map(
            ({ repository, path, section, commit, url, excerpt }) => ({
              repository,
              path,
              section,
              commit,
              url,
              excerpt,
            }),
          ),
        });
        return;
      }
      res.json({
        code:
          result?.grounding?.status === "GROUNDED"
            ? "LOCAL_UNAVAILABLE"
            : (result?.grounding?.status ?? "LOCAL_UNAVAILABLE"),
      });
    } catch {
      if (!controller.signal.aborted)
        res.status(503).json({ code: "DRAFT_UNAVAILABLE" });
    } finally {
      res.off("close", disconnect);
    }
  };
}
