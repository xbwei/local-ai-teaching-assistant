import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { courseIds, type CourseId } from "@laita/course-grounding";
import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readSync,
  lstatSync,
  realpathSync,
} from "node:fs";

import path from "node:path";

export interface CanvasConfiguration {
  enabled: true;
  canvasOrigin: string;
  courseId: string;
  userId: string;
  consumerKey: string;
  sharedSecret: string;
  demo?: { course: CourseId; studentUserId: string };
}
export function validateCanvasConfiguration(
  value: unknown,
): CanvasConfiguration {
  if (!value || typeof value !== "object") throw new Error();
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(",");
  if (
    (keys !== "canvasOrigin,consumerKey,courseId,enabled,sharedSecret,userId" &&
      keys !==
        "canvasOrigin,consumerKey,courseId,demo,enabled,sharedSecret,userId") ||
    v.enabled !== true
  )
    throw new Error();
  for (const key of [
    "canvasOrigin",
    "courseId",
    "userId",
    "consumerKey",
    "sharedSecret",
  ])
    if (
      typeof v[key] !== "string" ||
      !v[key] ||
      String(v[key]).length > 512 ||
      /[\x00-\x20\x7f]/u.test(String(v[key]))
    )
      throw new Error();
  const origin = new URL(String(v.canvasOrigin));
  if (
    origin.protocol !== "https:" ||
    origin.origin !== v.canvasOrigin ||
    origin.username ||
    origin.password
  )
    throw new Error();
  if (
    !/^\d{1,32}$/u.test(String(v.courseId)) ||
    !/^\d{1,32}$/u.test(String(v.userId)) ||
    String(v.sharedSecret).length < 32 ||
    String(v.consumerKey).length < 16
  )
    throw new Error();
  if (Object.hasOwn(v, "demo")) {
    if (!v.demo || typeof v.demo !== "object") throw new Error();
    const demo = v.demo as Record<string, unknown>;
    if (
      Object.keys(demo).sort().join(",") !== "course,studentUserId" ||
      !courseIds.some((course) => course === demo.course) ||
      typeof demo.studentUserId !== "string" ||
      !/^\d{1,32}$/u.test(demo.studentUserId) ||
      demo.studentUserId === v.userId
    )
      throw new Error();
  }
  return v as unknown as CanvasConfiguration;
}
export function assertCanvasDirectory(file: string): void {
  if (!path.isAbsolute(file) || file.split(path.sep).includes(".."))
    throw new Error();
  const parent = path.dirname(file),
    leaf = lstatSync(parent);
  if (
    realpathSync(parent) !== parent ||
    !leaf.isDirectory() ||
    leaf.uid !== process.getuid?.() ||
    (leaf.mode & 0o077) !== 0
  )
    throw new Error();
  for (let current = parent; ; current = path.dirname(current)) {
    const info = lstatSync(current);
    if (
      (info.uid !== 0 && info.uid !== process.getuid?.()) ||
      ((info.mode & 0o022) !== 0 &&
        !(info.uid === 0 && (info.mode & 0o1000) !== 0))
    )
      throw new Error();
    try {
      lstatSync(path.join(current, ".git"));
      throw new Error("Git configuration directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (current === path.dirname(current)) break;
  }
}

/** Optional external owner-only file; missing/malformed/disabled means unavailable.
 * Open without following a symlink; verify the opened descriptor, not a prior stat.
 */
export function readCanvasConfiguration(
  file: string | undefined,
): CanvasConfiguration | undefined {
  try {
    const value = readProtectedOwnerJson(file, 4096);
    return value === undefined ? undefined : validateCanvasConfiguration(value);
  } catch {
    return;
  }
}

export function readProtectedOwnerJson(
  file: string | undefined,
  maxBytes: number,
): unknown {
  if (!file) return;
  let fd: number | undefined;
  try {
    assertCanvasDirectory(file);
    fd = openSync(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const st = fstatSync(fd);
    if (
      !st.isFile() ||
      st.nlink !== 1 ||
      st.size > maxBytes ||
      st.uid !== process.getuid?.() ||
      (st.mode & 0o077) !== 0
    )
      return;
    // Detect a concurrent size change without retaining or parsing a larger file.
    const raw = Buffer.alloc(maxBytes + 1);
    const count = readSync(fd, raw);
    if (count !== st.size || count > maxBytes) return;
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(raw.subarray(0, count)),
    );
  } catch {
    return;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
const percent = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
export const canvasContext = (c: CanvasConfiguration, userId = c.userId) =>
  createHash("sha256")
    .update(JSON.stringify([c.canvasOrigin, c.courseId, userId]))
    .digest("hex");
export const canvasFingerprint = (c: CanvasConfiguration) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        canvasContext(c),
        c.consumerKey,
        c.sharedSecret,
        c.demo?.course,
        c.demo?.studentUserId,
      ]),
    )
    .digest("hex");

/** RFC 5849 form normalization. Preserve every signed field; reject ambiguous duplicates. */
export function verifyCanvasLaunch(
  body: string,
  c: CanvasConfiguration,
  launchUrl: string,
  now: number,
) {
  const pairs = [...new URLSearchParams(body)];
  if (pairs.length > 128) return;
  const fields = new Map<string, string>();
  for (const [key, value] of pairs) {
    if (fields.has(key) || !key || key.length > 128 || value.length > 4096)
      return;
    fields.set(key, value);
  }
  const get = (key: string) => fields.get(key);
  const timestamp = get("oauth_timestamp") ?? "";
  const nonce = get("oauth_nonce") ?? "";
  if (
    get("lti_message_type") !== "basic-lti-launch-request" ||
    get("lti_version") !== "LTI-1p0" ||
    get("oauth_version") !== "1.0" ||
    get("oauth_signature_method") !== "HMAC-SHA1" ||
    get("oauth_consumer_key") !== c.consumerKey ||
    fields.has("oauth_token") ||
    !/^\d{1,12}$/u.test(timestamp) ||
    Math.abs(now - Number(timestamp)) > 300 ||
    !/^[A-Za-z0-9._~-]{8,256}$/u.test(nonce)
  )
    return;
  const roles = (get("roles") ?? "").split(",");
  const instructor = roles.some(
    (role) =>
      role === "Instructor" || role === "urn:lti:role:ims/lis/Instructor",
  );
  const learner = roles.some(
    (role) => role === "Learner" || role === "urn:lti:role:ims/lis/Learner",
  );
  if (instructor === learner) return;
  const userId = instructor ? c.userId : c.demo?.studentUserId;
  if (!userId) return;
  // Canvas substitutions carry the origin and numeric Canvas IDs. All are signed.
  if (
    get("custom_canvas_api_domain") !== new URL(c.canvasOrigin).host ||
    get("custom_canvas_course_id") !== c.courseId ||
    get("custom_canvas_user_id") !== userId
  )
    return;
  const normalized = pairs
    .filter(([key]) => key !== "oauth_signature")
    .map(([key, value]) => [percent(key), percent(value)])
    .sort((a, b) =>
      a[0]! < b[0]!
        ? -1
        : a[0]! > b[0]!
          ? 1
          : a[1]! < b[1]!
            ? -1
            : a[1]! > b[1]!
              ? 1
              : 0,
    )
    .map((pair) => pair.join("="))
    .join("&");
  const expected = createHmac("sha1", `${percent(c.sharedSecret)}&`)
    .update(`POST&${percent(launchUrl)}&${percent(normalized)}`)
    .digest();
  const signature = get("oauth_signature") ?? "";
  if (!/^[A-Za-z0-9+/]{27}=$/u.test(signature)) return;
  const supplied = Buffer.from(signature, "base64");
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    return;
  return {
    role: instructor ? ("teacher" as const) : ("student" as const),
    context: canvasContext(c, userId),
    digest: createHash("sha256")
      .update(JSON.stringify([c.consumerKey, nonce]))
      .digest("hex"),
    expires: Number(timestamp) + 300,
  };
}
const xml = (value: string) =>
  value.replace(
    /[&<>"']/gu,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
export function canvasXml(publicOrigin: string, demo = false) {
  const origin = new URL(publicOrigin);
  if (origin.protocol !== "https:" || origin.origin !== publicOrigin)
    throw new Error();
  return `<?xml version="1.0" encoding="UTF-8"?>
<cartridge_basiclti_link xmlns="http://www.imsglobal.org/xsd/imslticc_v1p0" xmlns:blti="http://www.imsglobal.org/xsd/imsbasiclti_v1p0" xmlns:lticm="http://www.imsglobal.org/xsd/imslticm_v1p0">
  <blti:title>LAITA</blti:title><blti:description>Local teaching assistant</blti:description>
  <blti:launch_url>${xml(publicOrigin)}/api/v1/canvas/launch</blti:launch_url>
  <blti:custom><lticm:property name="canvas_api_domain">$Canvas.api.domain</lticm:property><lticm:property name="canvas_course_id">$Canvas.course.id</lticm:property><lticm:property name="canvas_user_id">$Canvas.user.id</lticm:property></blti:custom>
  <blti:extensions platform="canvas.instructure.com"><lticm:property name="privacy_level">anonymous</lticm:property><lticm:options name="course_navigation"><lticm:property name="url">${xml(publicOrigin)}/api/v1/canvas/launch</lticm:property><lticm:property name="text">LAITA</lticm:property><lticm:property name="visibility">${demo ? "members" : "admins"}</lticm:property><lticm:property name="default">enabled</lticm:property><lticm:property name="windowTarget">_blank</lticm:property></lticm:options></blti:extensions>
</cartridge_basiclti_link>`;
}
