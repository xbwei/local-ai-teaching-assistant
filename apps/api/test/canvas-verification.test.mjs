import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./browser-fixture.mjs";
import { canvas, signed, canvasNow } from "./canvas-fixture.mjs";
import {
  canvasVerificationFixture,
  verificationPath,
} from "./canvas-verification-fixture.mjs";

async function setup(t, count) {
  const synthetic = canvasVerificationFixture(undefined, count);
  const f = await fixture({
    autoLogin: false,
    canvas: () => canvas,
    authNow: () => canvasNow,
    canvasPages: synthetic.options,
  });
  t.after(() => f.close());
  const launch = await f.request("/api/v1/canvas/launch", {
    method: "POST",
    headers: {
      origin: canvas.canvasOrigin,
      "sec-fetch-site": "cross-site",
      "content-type": "application/x-www-form-urlencoded",
      cookie: "",
    },
    body: signed(`${f.config.publicOrigin}/api/v1/canvas/launch`),
  });
  assert.equal(launch.status, 303);
  const cookie = launch.headers.get("set-cookie").split(";")[0];
  const request = (body, signal, session = cookie) =>
    f.request(verificationPath, {
      method: body ? "POST" : "GET",
      headers: {
        cookie: session,
        "x-owner-client": "a".repeat(64),
        ...(body && { "content-type": "application/json" }),
      },
      ...(body && { body: JSON.stringify(body) }),
      ...(signal && { signal }),
    });
  const scope = async () => {
    const response = await request();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    return response.json();
  };
  const post = (scope, provider, studentId, signal) =>
    request(
      {
        scope,
        provider,
        studentId,
        assignmentId: "181",
      },
      signal,
    );
  return { synthetic, f, scope, request, post };
}

test("GitHub verification processes all 30 configured Canvas students without returning credentials or course data", async (t) => {
  const { synthetic, f, scope, post } = await setup(t);
  const plan = await scope();
  assert.deepEqual(
    plan.assignments.map((x) => x.studentIds),
    [synthetic.ids],
  );
  const results = [];
  for (const { provider, studentIds } of plan.assignments) {
    for (const id of studentIds) {
      const response = await post(plan.scope, provider, id);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const result = await response.json();
      assert.deepEqual(result, {
        state: "OBSERVED",
        attempt: 1,
        submittedAt: "2026-11-20T12:00:00Z",
        checks: [
          "PRESENT",
          id === synthetic.ids.at(-1) ? "OPEN" : "NOT_REQUIRED",
        ],
      });
      results.push(result);
    }
  }
  assert.equal(results.length, 30);
  assert.equal(synthetic.calls.github.filter((x) => x === "/user").length, 30);
  const output = JSON.stringify([plan, results, f.logs]);
  for (const marker of [
    "raw unprojected fixture text",
    "synthetic_github_reader",
    "README.md",
  ])
    assert.ok(!output.includes(marker));
});

test("verifier denies wrong scope and membership, handles absent or moved attempts, and reports partial results", async (t) => {
  const { synthetic, f, scope, request, post } = await setup(t, 3);
  assert.equal((await request(undefined, undefined, "")).status, 401);
  for (const role of ["admin", "teacher", "student"]) {
    assert.equal((await f.login(role)).status, 200);
    assert.equal((await request(undefined, undefined, f.cookie())).status, 403);
  }
  synthetic.canvas.remote.actorId = "73002";
  assert.equal((await request()).status, 503);
  synthetic.canvas.remote.actorId = canvas.userId;
  const plan = await scope();
  const [one, two] = synthetic.ids;
  assert.equal((await post("a".repeat(64), "GITHUB", one)).status, 409);
  assert.equal((await post(plan.scope, "GITHUB", "74100")).status, 403);
  assert.equal(
    (
      await request({
        scope: plan.scope,
        studentId: one,
        assignmentId: "181",
        provider: "GITHUB",
        url: "https://example.invalid/",
      })
    ).status,
    400,
  );
  assert.equal(synthetic.calls.github.length, 0);

  synthetic.state.inactive.add(one);
  assert.deepEqual(await (await post(plan.scope, "GITHUB", one)).json(), {
    state: "UNKNOWN",
    reason: "SOURCE_UNAVAILABLE",
  });
  synthetic.state.inactive.delete(one);
  synthetic.state.membership = (id) => [{ id: Number(id) + 1 }];
  assert.deepEqual(await (await post(plan.scope, "GITHUB", one)).json(), {
    state: "UNKNOWN",
    reason: "SOURCE_UNAVAILABLE",
  });
  synthetic.state.membership = (id) => [{ id: Number(id) }];
  synthetic.state.source = (row) => ({ ...row, user_id: Number(two) });
  assert.deepEqual(await (await post(plan.scope, "GITHUB", one)).json(), {
    state: "UNKNOWN",
    reason: "SOURCE_UNAVAILABLE",
  });
  synthetic.state.source = (row) => ({
    ...row,
    attempt: null,
    submitted_at: null,
    submission_type: null,
    workflow_state: "unsubmitted",
  });
  assert.deepEqual(await (await post(plan.scope, "GITHUB", one)).json(), {
    state: "UNKNOWN",
    reason: "NOT_SUBMITTED",
  });
  synthetic.state.source = (row) => ({
    ...row,
    url: "https://github.com/practice-74003/sample-work",
  });
  assert.deepEqual(await (await post(plan.scope, "GITHUB", one)).json(), {
    state: "UNKNOWN",
    reason: "SOURCE_UNAVAILABLE",
  });
  assert.equal(synthetic.calls.github.length, 0);

  synthetic.state.source = (row) => ({
    ...row,
    body: `<p><a href="https://github.com/practice-74003/sample-work">https://github.com/practice-74002/sample-work</a></p>`,
  });
  assert.deepEqual(await (await post(plan.scope, "GITHUB", two)).json(), {
    state: "UNKNOWN",
    reason: "SOURCE_UNAVAILABLE",
  });
  assert.equal(synthetic.calls.github.length, 0);

  synthetic.state.source = (row) => row;
  synthetic.state.github = (url) =>
    url.pathname.includes("/git/trees/")
      ? Response.json({ truncated: true })
      : undefined;
  assert.equal(
    (await (await post(plan.scope, "GITHUB", two)).json()).state,
    "PARTIAL",
  );
  synthetic.state.github = (url) =>
    url.pathname.startsWith("/users/")
      ? Response.json({ id: 1234, type: "User", login: "unrelated" })
      : undefined;
  assert.equal(
    (await (await post(plan.scope, "GITHUB", two)).json()).state,
    "UNKNOWN",
  );
  synthetic.state.github = () => {
    synthetic.state.source = (row) => ({ ...row, attempt: 2 });
  };
  assert.deepEqual(await (await post(plan.scope, "GITHUB", two)).json(), {
    state: "UNKNOWN",
    reason: "ATTEMPT_CHANGED",
  });
  synthetic.state.source = (row) => row;

  synthetic.configuration.assignments[0].paths.push("exercise.txt");
  assert.equal((await post(plan.scope, "GITHUB", one)).status, 409);
});

test("verification admits one operation and cancels the GitHub request without starting the next row", async (t) => {
  const { synthetic, scope, post } = await setup(t, 2);
  const plan = await scope();
  const entered = Promise.withResolvers();
  const stopped = Promise.withResolvers();
  synthetic.state.github = async (_, { signal }) => {
    entered.resolve();
    if (!signal.aborted)
      await new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true }),
      );
    stopped.resolve();
    signal.throwIfAborted();
  };
  const controller = new AbortController();
  const running = post(
    plan.scope,
    "GITHUB",
    synthetic.ids[0],
    controller.signal,
  );
  await entered.promise;
  assert.equal(
    (await post(plan.scope, "GITHUB", synthetic.ids[1])).status,
    409,
  );
  controller.abort();
  await assert.rejects(running, { name: "AbortError" });
  await stopped.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(synthetic.calls.github, ["/user"]);
});
