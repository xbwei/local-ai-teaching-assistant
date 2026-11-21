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

export function canvasPageFixture({
  assignments = false,
  modules = false,
  chat = false,
  feedback = false,
} = {}) {
  const testStudent = "73009";
  const settings = {
    origin: canvas.canvasOrigin,
    courseId: canvas.courseId,
    teacherId: canvas.userId,
    expiresAt: new Date(canvasNow + 3600_000).toISOString(),
    canvasToken: "synthetic-rest-token-for-fixtures",
    ...(assignments && {
      assignments: { groupId: "72", editableIds: ["81", "82"] },
    }),
    ...(modules && {
      modules: { moduleIds: ["61"], pageIds: ["9002"], assignmentIds: ["81"] },
    }),
    ...(chat && {
      chat: { testStudentId: testStudent, assignmentIds: ["81"] },
    }),
    ...(feedback && {
      feedback: { testStudentId: testStudent, assignmentIds: ["81"] },
    }),
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
  const assignmentWrites = [];
  const feedbackWrites = [];
  const assignmentRows = new Map([
    [
      "81",
      {
        id: 81,
        course_id: Number(canvas.courseId),
        name: "Synthetic draft",
        updated_at: "2026-11-20T12:00:00Z",
        published: true,
        is_quiz_assignment: false,
        post_manually: false,
        description: "<p>Original instructions.</p>",
        assignment_group_id: 72,
        group_category_id: null,
        points_possible: 7,
        submission_types: ["online_url"],
        due_at: null,
      },
    ],
  ]);
  const moduleWrites = [];
  const moduleRows = new Map([
    [
      "61",
      {
        id: 61,
        name: "Studio module",
        published: false,
        position: 1,
        items: [],
      },
    ],
  ]);
  const linkedPage = {
    page_id: 9002,
    title: "Maps and examples",
    url: "maps-and-examples",
    published: true,
  };
  let page;
  const remote = {
    actorId: canvas.userId,
    course,
    before: undefined,
    afterCreate: undefined,
    readBack: (value) => value,
    group: { id: 72, name: "Studio Exercises" },
    assignmentRead: (value) => value,
    afterAssignmentWrite: undefined,
    afterModuleWrite: undefined,
    moduleRead: (value) => value,
    studentView: [{ id: Number(testStudent), name: "Synthetic Test Student" }],
    feedbackRead: (value) => value,
    feedbackReceipt: (value) => value,
    comments: [
      { id: 700, author_id: 73001, comment: "Synthetic prior comment" },
    ],
    submission: {
      id: 315,
      user_id: Number(testStudent),
      assignment_id: 81,
      assignment_visible: true,
      attempt: 1,
      submitted_at: "2026-11-20T12:00:00Z",
      posted_at: "2026-11-20T13:00:00Z",
      submission_type: "online_url",
      workflow_state: "graded",
      grade_matches_current_submission: true,
      score: 6.5,
      excused: false,
      missing: false,
      body: "Synthetic submission body outside Chat output",
    },
  };
  const options = {
    settings: () => settings,
    async fetcher(url, init) {
      const target = new URL(url);
      assert.equal(target.origin, canvas.canvasOrigin);
      assert.equal(init.redirect, "error");
      assert.equal(init.cache, "no-store");
      assert.equal(
        new Headers(init.headers).get("Authorization"),
        `Bearer ${settings.canvasToken}`,
      );
      const endpoint = target.pathname.replace("/api/v1", "");
      const coursePath = `/courses/${canvas.courseId}`;
      const studentViewPath = `${coursePath}/users`;
      const submissionPath = `${coursePath}/assignments/81/submissions/${testStudent}`;
      assert.equal(
        target.search,
        endpoint === studentViewPath
          ? `?user_ids%5B%5D=${testStudent}&enrollment_type%5B%5D=student_view&enrollment_state%5B%5D=active&per_page=2`
          : endpoint === submissionPath && init.method === "GET"
            ? feedback &&
              target.searchParams
                .getAll("include[]")
                .includes("submission_comments")
              ? "?include%5B%5D=visibility&include%5B%5D=group&include%5B%5D=submission_comments"
              : "?include%5B%5D=visibility"
            : /\/modules\/\d+$/u.test(endpoint)
              ? "?include%5B%5D=items"
              : "",
      );
      calls.push([init.method, endpoint]);
      await remote.before?.(init.method, endpoint, init.signal);
      if (init.method === "GET" && endpoint === "/users/self")
        return Response.json({ id: remote.actorId });
      if (init.method === "GET" && endpoint === coursePath)
        return Response.json(remote.course);
      if ((chat || feedback) && init.method === "GET") {
        if (endpoint === studentViewPath)
          return Response.json(remote.studentView, {
            headers: { Link: `<${url}>; rel="current"` },
          });
        if (endpoint === submissionPath) {
          const full = target.searchParams
            .getAll("include[]")
            .includes("submission_comments");
          return Response.json(
            full
              ? remote.feedbackRead({
                  ...remote.submission,
                  submission_comments: remote.comments,
                })
              : remote.submission,
          );
        }
      }
      if (feedback && init.method === "PUT" && endpoint === submissionPath) {
        const fields = Object.fromEntries(new URLSearchParams(init.body));
        feedbackWrites.push({ endpoint, fields });
        const comment = fields["comment[text_comment]"];
        assert.doesNotMatch(comment, /[<>]|&(?!amp;|lt;|gt;)/u);
        remote.comments.push({
          id: 700 + feedbackWrites.length,
          author_id: Number(canvas.userId),
          attempt: Number(fields["comment[attempt]"]),
          comment: comment.replace(
            /&(amp|lt|gt);/gu,
            (_, entity) => ({ amp: "&", lt: "<", gt: ">" })[entity],
          ),
        });
        const value = await remote.feedbackReceipt({
          ...remote.submission,
          submission_comments: remote.comments,
        });
        return Response.json(value);
      }
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
      if (modules) {
        const modulePath = `${coursePath}/modules`;
        if (
          init.method === "GET" &&
          endpoint === `${coursePath}/pages/page_id:9002`
        )
          return Response.json(linkedPage);
        if (init.method === "GET" && endpoint.startsWith(modulePath + "/")) {
          const row = moduleRows.get(endpoint.slice(modulePath.length + 1));
          return row
            ? Response.json(
                remote.moduleRead({ ...row, items_count: row.items.length }),
              )
            : Response.json({}, { status: 404 });
        }
        if (init.method === "POST" && endpoint === modulePath) {
          const fields = Object.fromEntries(new URLSearchParams(init.body));
          moduleWrites.push({ endpoint, fields });
          const row = {
            id: 62,
            name: fields["module[name]"],
            position: 2,
            published: false,
            items: [],
          };
          moduleRows.set("62", row);
          await remote.afterModuleWrite?.(row);
          return Response.json({ id: row.id });
        }
        if (init.method === "POST" && endpoint === modulePath + "/61/items") {
          const fields = Object.fromEntries(new URLSearchParams(init.body));
          moduleWrites.push({ endpoint, fields });
          const row = moduleRows.get("61");
          const page = fields["module_item[type]"] === "Page";
          const item = {
            id: 101 + row.items.length,
            module_id: row.id,
            position: (row.items.at(-1)?.position ?? 0) + 1,
            type: fields["module_item[type]"],
            published: page
              ? linkedPage.published
              : assignmentRows.get("81").published,
            ...(page
              ? { page_url: fields["module_item[page_url]"] }
              : { content_id: Number(fields["module_item[content_id]"]) }),
          };
          row.items.push(item);
          await remote.afterModuleWrite?.(item);
          return Response.json({ id: item.id, module_id: row.id });
        }
      }
      if (assignments || modules || chat || feedback) {
        if (
          init.method === "GET" &&
          endpoint === `${coursePath}/assignment_groups/72`
        )
          return Response.json(remote.group);
        const assignmentPath = `${coursePath}/assignments`;
        const exactId = endpoint.startsWith(assignmentPath + "/")
          ? endpoint.slice(assignmentPath.length + 1)
          : "";
        if (init.method === "GET" && exactId) {
          const row = assignmentRows.get(exactId);
          return row
            ? Response.json(remote.assignmentRead(row))
            : Response.json({}, { status: 404 });
        }
        const creating = init.method === "POST" && endpoint === assignmentPath;
        const editing = init.method === "PUT" && assignmentRows.has(exactId);
        if (creating || editing) {
          const fields = new URLSearchParams(init.body);
          assignmentWrites.push({
            method: init.method,
            endpoint,
            fields: [...fields],
          });
          const id = creating ? "91" : exactId;
          const previous = assignmentRows.get(id);
          const row = creating
            ? {
                id: Number(id),
                course_id: Number(canvas.courseId),
                name: fields.get("assignment[name]"),
                updated_at: "2026-11-20T12:00:01Z",
                description: fields.get("assignment[description]"),
                points_possible: Number(
                  fields.get("assignment[points_possible]"),
                ),
                submission_types: fields.getAll(
                  "assignment[submission_types][]",
                ),
                assignment_group_id: Number(
                  fields.get("assignment[assignment_group_id]"),
                ),
                due_at: fields.get("assignment[due_at]"),
                published: fields.get("assignment[published]") === "true",
              }
            : {
                ...previous,
                name: fields.get("assignment[name]"),
                updated_at: "2026-11-20T12:00:01Z",
              };
          assignmentRows.set(id, row);
          await remote.afterAssignmentWrite?.(row);
          return Response.json({ id: row.id, course_id: row.course_id });
        }
      }
      assert.fail(
        `Unexpected synthetic Canvas endpoint ${init.method} ${endpoint}`,
      );
    },
  };
  return {
    options,
    settings,
    remote,
    calls,
    writes,
    assignmentWrites,
    feedbackWrites,
    assignmentRows,
    moduleWrites,
    moduleRows,
    linkedPage,
  };
}
