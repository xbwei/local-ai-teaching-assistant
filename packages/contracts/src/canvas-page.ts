import { utf8Bytes } from "./provider-control.ts";

export interface CanvasPageDraft {
  title: string;
  body: string;
}

export interface CanvasPagePreview {
  planId: string;
  target: {
    origin: string;
    courseId: string;
    courseName: string;
    teacherId: string;
  };
  draft: CanvasPageDraft;
}

export type CanvasPageResult =
  | { status: "VERIFIED" | "UNVERIFIED"; pageId: string }
  | { status: "UNCERTAIN" };

const invalidPageText =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\p{Cs}]/u;
export const canvasPageId = (value: unknown): value is string =>
  typeof value === "string" && /^[1-9]\d{0,14}$/u.test(value);
export const canvasPagePlanId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

export function canvasPageTitle(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 250 &&
    value.trim() === value &&
    value.length > 0 &&
    !invalidPageText.test(value) &&
    !/[\n\t\u2028\u2029]/u.test(value)
  );
}

/** Canonicalize balanced, attribute-free HTML. Validate before interpreting it. */
export function safeLessonHtml(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 16000 ||
    invalidPageText.test(value)
  )
    throw new Error("INVALID_HTML");
  const tags = new Set([
    "p",
    "h2",
    "h3",
    "ul",
    "ol",
    "li",
    "strong",
    "em",
    "pre",
    "code",
    "blockquote",
  ]);
  const stack: string[] = [];
  let result = "";
  for (const token of value.split(/(<[^>]*>)/u)) {
    if (token.startsWith("<")) {
      const m = /^<(\/?)([a-z0-9]+)\s*(\/?)>$/iu.exec(token);
      if (!m) throw new Error("INVALID_HTML");
      const name = m[2]!.toLowerCase();
      const parent = stack.at(-1);
      if (
        !m[1] &&
        (((parent === "ul" || parent === "ol") && name !== "li") ||
          (name === "li" && parent !== "ul" && parent !== "ol") ||
          (parent &&
            ["p", "h2", "h3", "strong", "em", "pre", "code"].includes(parent) &&
            !["strong", "em", "code", "br"].includes(name)))
      )
        throw new Error("INVALID_HTML");
      if (name === "br" && !m[1]) {
        result += "<br>";
        continue;
      }
      if (!tags.has(name) || m[3]) throw new Error("INVALID_HTML");
      if (m[1]) {
        if (stack.pop() !== name) throw new Error("INVALID_HTML");
      } else {
        if (stack.length >= 12) throw new Error("INVALID_HTML");
        stack.push(name);
      }
      result += `<${m[1]}${name}>`;
    } else {
      if (
        token.includes("<") ||
        ((stack.at(-1) === "ul" || stack.at(-1) === "ol") &&
          token.trim() !== "") ||
        /&(?!(?:amp|lt|gt|quot|apos|nbsp|#39);)/u.test(token)
      )
        throw new Error("INVALID_HTML");
      result += token.replaceAll(">", "&gt;");
    }
  }
  if (
    utf8Bytes(result) > 16000 ||
    stack.length ||
    !result.replace(/<[^>]+>/gu, "").trim()
  )
    throw new Error("INVALID_HTML");
  return result;
}

export function readCanvasPageDraft(value: unknown): CanvasPageDraft {
  if (!value || typeof value !== "object") throw new Error("INVALID_DRAFT");
  const { title, body } = value as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(",") !== "body,title" ||
    !canvasPageTitle(title)
  )
    throw new Error("INVALID_DRAFT");
  return { title, body: safeLessonHtml(body) };
}

export function sameCanvasPageDraft(a: CanvasPageDraft, b: CanvasPageDraft) {
  return a.title === b.title && a.body === b.body;
}
