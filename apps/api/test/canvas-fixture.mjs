import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

export const canvasNow = 1900000000000;
export const canvas = {
  enabled: true,
  canvasOrigin: "https://canvas.example.test",
  courseId: "42001",
  userId: "73001",
  consumerKey: "synthetic-consumer-key-not-for-use",
  sharedSecret: "synthetic-shared-secret-not-a-real-credential",
};
// Independent RFC 5849 reference signer in tests; never a product signing endpoint.
const encode = (s) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase(),
  );
export function signed(url, changes = {}, secret = canvas.sharedSecret) {
  const fields = {
    lti_message_type: "basic-lti-launch-request",
    lti_version: "LTI-1p0",
    oauth_version: "1.0",
    oauth_signature_method: "HMAC-SHA1",
    oauth_consumer_key: canvas.consumerKey,
    oauth_nonce: "synthetic-nonce-0001",
    oauth_timestamp: String(canvasNow / 1000),
    roles: "Instructor",
    custom_canvas_api_domain: "canvas.example.test",
    custom_canvas_course_id: canvas.courseId,
    custom_canvas_user_id: canvas.userId,
    ...changes,
  };
  const params = Object.entries(fields)
    .map(([k, v]) => `${encode(k)}=${encode(v)}`)
    .sort()
    .join("&");
  fields.oauth_signature = createHmac("sha1", encode(secret) + "&")
    .update(["POST", encode(url), encode(params)].join("&"))
    .digest("base64");
  return new URLSearchParams(fields).toString();
}

export function canvasPageFixture() {
  const settings = {
    origin: canvas.canvasOrigin,
    courseId: canvas.courseId,
    teacherId: canvas.userId,
    expiresAt: new Date(canvasNow + 3600_000).toISOString(),
    canvasToken: "synthetic-rest-token-for-fixtures",
  };
  const course = {
    id: Number(canvas.courseId),
    name: "Synthetic Studio",
    workflow_state: "available",
    enrollments: [
      {
        type: "teacher",
        user_id: Number(canvas.userId),
        enrollment_state: "active",
      },
    ],
  };
  const calls = [];
  const writes = [];
  let page;
  const remote = {
    actorId: canvas.userId,
    course,
    before: undefined,
    afterCreate: undefined,
    readBack: (value) => value,
  };
  const options = {
    settings: () => settings,
    async fetcher(url, init) {
      const target = new URL(url);
      assert.equal(target.origin, canvas.canvasOrigin);
      assert.equal(target.search, "");
      assert.equal(init.redirect, "error");
      assert.equal(init.cache, "no-store");
      assert.equal(
        new Headers(init.headers).get("Authorization"),
        `Bearer ${settings.canvasToken}`,
      );
      const endpoint = target.pathname.replace("/api/v1", "");
      calls.push([init.method, endpoint]);
      await remote.before?.(init.method, endpoint, init.signal);
      if (init.method === "GET" && endpoint === "/users/self")
        return Response.json({ id: remote.actorId });
      const coursePath = `/courses/${canvas.courseId}`;
      if (init.method === "GET" && endpoint === coursePath)
        return Response.json(remote.course);
      if (init.method === "POST" && endpoint === `${coursePath}/pages`) {
        const fields = Object.fromEntries(new URLSearchParams(init.body));
        writes.push(fields);
        page = {
          page_id: 9001,
          title: fields["wiki_page[title]"],
          body: fields["wiki_page[body]"],
          published: fields["wiki_page[published]"] === "true",
          editing_roles: fields["wiki_page[editing_roles]"],
        };
        await remote.afterCreate?.();
        return Response.json({ page_id: page.page_id });
      }
      if (
        init.method === "GET" &&
        endpoint === `${coursePath}/pages/page_id:9001`
      )
        return Response.json(remote.readBack(page));
      assert.fail(
        `Unexpected synthetic Canvas endpoint ${init.method} ${endpoint}`,
      );
    },
  };
  return { options, settings, remote, calls, writes };
}
