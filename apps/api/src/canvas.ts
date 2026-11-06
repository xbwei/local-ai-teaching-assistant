import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
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
}
export function validateCanvasConfiguration(
  value: unknown,
): CanvasConfiguration {
  if (!value || typeof value !== "object") throw new Error();
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).sort().join(",") !==
      "canvasOrigin,consumerKey,courseId,enabled,sharedSecret,userId" ||
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
      st.size > 4096 ||
      st.uid !== process.getuid?.() ||
      (st.mode & 0o077) !== 0
    )
      return;
    return validateCanvasConfiguration(JSON.parse(readFileSync(fd, "utf8")));
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
export const canvasContext = (c: CanvasConfiguration) =>
  createHash("sha256")
    .update(JSON.stringify([c.canvasOrigin, c.courseId, c.userId]))
    .digest("hex");
export const canvasFingerprint = (c: CanvasConfiguration) =>
  createHash("sha256")
    .update(JSON.stringify([canvasContext(c), c.consumerKey, c.sharedSecret]))
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
  if (
    !roles.includes("Instructor") &&
    !roles.includes("urn:lti:role:ims/lis/Instructor")
  )
    return;
  // Canvas substitutions carry the origin and numeric Canvas IDs. All are signed.
  if (
    get("custom_canvas_api_domain") !== new URL(c.canvasOrigin).host ||
    get("custom_canvas_course_id") !== c.courseId ||
    get("custom_canvas_user_id") !== c.userId
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
export function canvasXml(publicOrigin: string) {
  const origin = new URL(publicOrigin);
  if (origin.protocol !== "https:" || origin.origin !== publicOrigin)
    throw new Error();
  return `<?xml version="1.0" encoding="UTF-8"?>
<cartridge_basiclti_link xmlns="http://www.imsglobal.org/xsd/imslticc_v1p0" xmlns:blti="http://www.imsglobal.org/xsd/imsbasiclti_v1p0" xmlns:lticm="http://www.imsglobal.org/xsd/imslticm_v1p0">
  <blti:title>LAITA</blti:title><blti:description>Single-owner local teaching assistant</blti:description>
  <blti:launch_url>${xml(publicOrigin)}/api/v1/canvas/launch</blti:launch_url>
  <blti:custom><lticm:property name="canvas_api_domain">$Canvas.api.domain</lticm:property><lticm:property name="canvas_course_id">$Canvas.course.id</lticm:property><lticm:property name="canvas_user_id">$Canvas.user.id</lticm:property></blti:custom>
  <blti:extensions platform="canvas.instructure.com"><lticm:property name="privacy_level">anonymous</lticm:property><lticm:options name="course_navigation"><lticm:property name="url">${xml(publicOrigin)}/api/v1/canvas/launch</lticm:property><lticm:property name="text">LAITA</lticm:property><lticm:property name="visibility">admins</lticm:property><lticm:property name="default">enabled</lticm:property><lticm:property name="windowTarget">_blank</lticm:property></lticm:options></blti:extensions>
</cartridge_basiclti_link>`;
}
