import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./browser-fixture.mjs";
import { canvas, signed, canvasNow } from "./canvas-fixture.mjs";
import {
  canvasVerificationFixture,
  verificationPath,
  verificationSecretMarker,
} from "./canvas-verification-fixture.mjs";

async function setup(t, count, now = () => canvasNow) {
  const synthetic = canvasVerificationFixture(undefined, count);
  const f = await fixture({
    autoLogin: false,
    canvas: () => canvas,
    authNow: now,
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
  const request = (body, signal, session = cookie, path = verificationPath) =>
    f.request(path, {
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
  const selection = (scope, provider, studentId) => ({
    scope,
    provider,
    studentId,
    assignmentId: provider === "GITHUB" ? "181" : "182",
  });
  const preview = (scope, provider, studentId, signal, session) =>
    request(
      selection(scope, provider, studentId),
      signal,
      session,
      verificationPath + "/preview",
    );
  const post = (scope, provider, studentId, version, signal, session) =>
    request(
      { ...selection(scope, provider, studentId), version },
      signal,
      session,
    );
  const check = async (scope, provider, studentId, signal) => {
    const response = await preview(scope, provider, studentId);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.state, "READY");
    return post(scope, provider, studentId, result.version, signal);
  };
  return { synthetic, f, scope, request, preview, post, check };
}

test("the Canvas assignment verifiers process all 30 configured students per provider without returning credentials or course data", async (t) => {
  const { synthetic, f, scope, preview, post } = await setup(t);
  const plan = await scope();
  assert.deepEqual(
    plan.assignments.map((x) => x.studentIds),
    [synthetic.ids, synthetic.ids],
  );
  const previews = [];
  for (const { provider, studentIds } of plan.assignments) {
    for (const id of studentIds) {
      const response = await preview(plan.scope, provider, id);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const result = await response.json();
      assert.match(result.version, /^[a-f0-9]{64}$/u);
      assert.deepEqual(result, {
        state: "READY",
        attempt: 1,
        submittedAt: "2026-11-20T12:00:00Z",
        version: result.version,
      });
      previews.push({ provider, id, version: result.version });
    }
  }
  assert.deepEqual(synthetic.calls.github, []);
  assert.deepEqual(synthetic.calls.mongo, []);
  const results = [];
  for (const { provider, id, version } of previews) {
    const response = await post(plan.scope, provider, id, version);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const result = await response.json();
    assert.deepEqual(result, {
      state: "OBSERVED",
      attempt: 1,
      submittedAt: "2026-11-20T12:00:00Z",
      checks:
        provider === "GITHUB"
          ? ["PRESENT", id === synthetic.ids.at(-1) ? "OPEN" : "NOT_REQUIRED"]
          : ["PRESENT", "PRESENT"],
    });
    results.push(result);
  }
  assert.equal(results.length, 60);
  assert.deepEqual(synthetic.calls.mongo, synthetic.ids);
  assert.equal(synthetic.calls.github.filter((x) => x === "/user").length, 30);
  const output = JSON.stringify([plan, previews, results, f.logs]);
  for (const marker of [
    verificationSecretMarker,
    "example.mongodb.net",
    "raw unprojected fixture text",
    "synthetic_github_reader",
    "README.md",
  ])
    assert.ok(!output.includes(marker));
  assert.equal(synthetic.state.activeWorkers, 0);
});

test("a verifier runs only against the exact previous preview in the same signed session", async (t) => {
  const { synthetic, f, scope, request, preview, post } = await setup(t, 2);
  const plan = await scope();
  const [student, other] = synthetic.ids;
  assert.equal(
    (
      await request({
        scope: plan.scope,
        assignmentId: "181",
        provider: "GITHUB",
        studentId: student,
      })
    ).status,
    400,
  );
  const { version } = await (
    await preview(plan.scope, "GITHUB", student)
  ).json();
  assert.match(version, /^[a-f0-9]{64}$/u);
  const changed = { state: "UNKNOWN", reason: "ATTEMPT_CHANGED" };
  for (const [provider, id, proof] of [
    ["GITHUB", student, "a".repeat(64)],
    ["GITHUB", other, version],
    ["MONGODB", student, version],
  ]) {
    assert.deepEqual(
      await (await post(plan.scope, provider, id, proof)).json(),
      changed,
    );
  }
  for (const modify of [
    (row) => ({ ...row, attempt: 2 }),
    (row) => ({ ...row, submitted_at: "2026-11-20T12:01:00Z" }),
    (row) => ({ ...row, url: row.url + "/" }),
    (row) => ({
      ...row,
      attempt: null,
      submitted_at: null,
      submission_type: null,
      workflow_state: "unsubmitted",
    }),
  ]) {
    synthetic.state.source = modify;
    assert.deepEqual(
      await (await post(plan.scope, "GITHUB", student, version)).json(),
      changed,
    );
  }
  synthetic.state.source = (row) => row;
  const mongo = await (await preview(plan.scope, "MONGODB", student)).json();
  synthetic.state.source = (row) => ({
    ...row,
    body: row.body.replace(
      verificationSecretMarker,
      "changed-synthetic-marker",
    ),
  });
  assert.deepEqual(
    await (await post(plan.scope, "MONGODB", student, mongo.version)).json(),
    changed,
  );
  synthetic.state.source = (row) => row;

  const launchPath = "/api/v1/canvas/launch";
  const launch = await f.request(launchPath, {
    method: "POST",
    headers: {
      origin: canvas.canvasOrigin,
      "sec-fetch-site": "cross-site",
      "content-type": "application/x-www-form-urlencoded",
      cookie: "",
    },
    body: signed(f.config.publicOrigin + launchPath, {
      oauth_nonce: "synthetic-verify-other-session",
    }),
  });
  assert.equal(launch.status, 303);
  const another = launch.headers.get("set-cookie").split(";")[0];
  const secondScope = await (
    await request(undefined, undefined, another)
  ).json();
  assert.notEqual(secondScope.scope, plan.scope);
  assert.deepEqual(
    await (
      await post(
        secondScope.scope,
        "GITHUB",
        student,
        version,
        undefined,
        another,
      )
    ).json(),
    changed,
  );
  assert.deepEqual(synthetic.calls.github, []);
  assert.deepEqual(synthetic.calls.mongo, []);
  const fresh = await (
    await preview(secondScope.scope, "GITHUB", student, undefined, another)
  ).json();
  assert.notEqual(fresh.version, version);
  assert.equal(
    (
      await (
        await post(
          secondScope.scope,
          "GITHUB",
          student,
          fresh.version,
          undefined,
          another,
        )
      ).json()
    ).state,
    "OBSERVED",
  );
});

test("verifier denies wrong scope and membership, handles absent or moved attempts, and reports partial results", async (t) => {
  const { synthetic, f, scope, request, preview, post, check } = await setup(
    t,
    3,
  );
  assert.equal((await request(undefined, undefined, "")).status, 401);
  for (const role of ["admin", "teacher", "student"]) {
    assert.equal((await f.login(role)).status, 200);
    assert.equal((await request(undefined, undefined, f.cookie())).status, 403);
  }
  synthetic.canvas.remote.actorId = "73002";
  assert.equal((await request()).status, 503);
  synthetic.canvas.remote.actorId = canvas.userId;
  const plan = await scope();
  const [one, two, three] = synthetic.ids;
  assert.equal((await preview("a".repeat(64), "GITHUB", one)).status, 409);
  assert.equal((await preview(plan.scope, "GITHUB", "74100")).status, 403);
  assert.equal(
    (await post(plan.scope, "GITHUB", "74100", "a".repeat(64))).status,
    403,
  );
  assert.equal(
    (
      await request({
        scope: plan.scope,
        studentId: one,
        assignmentId: "181",
        provider: "GITHUB",
        version: "a".repeat(64),
        url: "https://example.invalid/",
      })
    ).status,
    400,
  );
  assert.equal(synthetic.calls.github.length, 0);

  synthetic.state.inactive.add(one);
  assert.deepEqual(await (await preview(plan.scope, "GITHUB", one)).json(), {
    state: "BLOCKED",
  });
  synthetic.state.inactive.delete(one);
  synthetic.state.membership = (id) => [{ id: Number(id) + 1 }];
  assert.deepEqual(await (await preview(plan.scope, "GITHUB", one)).json(), {
    state: "BLOCKED",
  });
  synthetic.state.membership = (id) => [{ id: Number(id) }];
  synthetic.state.source = (row) => ({ ...row, user_id: Number(two) });
  for (const provider of ["GITHUB", "MONGODB"]) {
    assert.deepEqual(await (await preview(plan.scope, provider, one)).json(), {
      state: "BLOCKED",
    });
  }
  assert.equal(synthetic.calls.mongo.length, 0);
  synthetic.state.source = (row) => ({
    ...row,
    body: row.body.replace("sample-74001", "sample-74002"),
  });
  assert.deepEqual(await (await preview(plan.scope, "MONGODB", one)).json(), {
    state: "BLOCKED",
  });
  assert.equal(synthetic.calls.mongo.length, 0);
  synthetic.state.source = (row) => ({
    ...row,
    attempt: null,
    submitted_at: null,
    submission_type: null,
    workflow_state: "unsubmitted",
  });
  assert.deepEqual(await (await preview(plan.scope, "GITHUB", one)).json(), {
    state: "NOT_APPLICABLE",
  });
  synthetic.state.source = (row) => ({
    ...row,
    url: "https://github.com/practice-74003/sample-work",
  });
  assert.deepEqual(await (await preview(plan.scope, "GITHUB", one)).json(), {
    state: "BLOCKED",
  });
  assert.equal(synthetic.calls.github.length, 0);

  synthetic.state.source = (row) => ({
    ...row,
    body: `<p><a href="https://github.com/practice-74003/sample-work">https://github.com/practice-74002/sample-work</a></p>`,
  });
  assert.deepEqual(await (await preview(plan.scope, "GITHUB", two)).json(), {
    state: "BLOCKED",
  });
  assert.equal(synthetic.calls.github.length, 0);

  synthetic.state.source = (row) => row;
  synthetic.state.github = (url) =>
    url.pathname.includes("/git/trees/")
      ? Response.json({ truncated: true })
      : undefined;
  assert.equal(
    (await (await check(plan.scope, "GITHUB", two)).json()).state,
    "PARTIAL",
  );
  synthetic.state.github = (url) =>
    url.pathname.startsWith("/users/")
      ? Response.json({ id: 1234, type: "User", login: "unrelated" })
      : undefined;
  assert.equal(
    (await (await check(plan.scope, "GITHUB", two)).json()).state,
    "UNKNOWN",
  );
  synthetic.state.github = () => {
    synthetic.state.source = (row) => ({ ...row, attempt: 2 });
  };
  assert.deepEqual(await (await check(plan.scope, "GITHUB", two)).json(), {
    state: "UNKNOWN",
    reason: "ATTEMPT_CHANGED",
  });
  synthetic.state.source = (row) => row;

  synthetic.state.mongo = () => {
    synthetic.state.source = (row) => ({ ...row, attempt: 2 });
  };
  assert.deepEqual(await (await check(plan.scope, "MONGODB", three)).json(), {
    state: "UNKNOWN",
    reason: "ATTEMPT_CHANGED",
  });
  assert.equal(synthetic.state.activeWorkers, 0);
  synthetic.configuration.assignments[0].paths.push("exercise.txt");
  assert.equal((await preview(plan.scope, "GITHUB", one)).status, 409);
});

test("verification admits one operation and cancels without leaving an active worker", async (t) => {
  const { synthetic, scope, preview, check } = await setup(t, 2);
  const plan = await scope();
  const entered = Promise.withResolvers();
  const stopped = Promise.withResolvers();
  synthetic.state.mongo = async (_, signal) => {
    entered.resolve();
    if (!signal.aborted)
      await new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true }),
      );
    stopped.resolve();
    signal.throwIfAborted();
  };
  const controller = new AbortController();
  const running = check(
    plan.scope,
    "MONGODB",
    synthetic.ids[0],
    controller.signal,
  );
  await Promise.race([
    entered.promise,
    running.then(() =>
      assert.fail("Verification settled before the worker started"),
    ),
  ]);
  assert.equal(
    (await preview(plan.scope, "GITHUB", synthetic.ids[1])).status,
    409,
  );
  controller.abort();
  await assert.rejects(running, { name: "AbortError" });
  await stopped.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(synthetic.state.activeWorkers, 0);
  assert.equal(synthetic.calls.github.length, 0);
});

test("MongoDB-only verification withholds changed or incomplete evidence and rejects reused credentials", async (t) => {
  const { synthetic, scope, preview, check } = await setup(t, 1);
  const [student] = synthetic.ids;
  const settings = synthetic.configuration;
  const [mongo] = settings.assignments.filter((x) => x.provider === "MONGODB");
  settings.assignments = [mongo];
  settings.github = null;
  const plan = await scope();
  assert.deepEqual(plan.assignments, [
    { provider: "MONGODB", assignmentId: "182", studentIds: [student] },
  ]);

  synthetic.state.source = (row) => ({
    ...row,
    body: row.body.replace(
      verificationSecretMarker + student,
      canvas.sharedSecret,
    ),
  });
  const verify = async (p = plan) => {
    const response = await check(p.scope, "MONGODB", student);
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.deepEqual(
    await (await preview(plan.scope, "MONGODB", student)).json(),
    {
      state: "BLOCKED",
    },
  );
  assert.deepEqual(synthetic.calls.mongo, []);

  synthetic.state.source = (row) => row;
  const partial = {
    connection: { status: "PRESENT" },
    cleanup: "COMPLETE",
    collections: [{ status: "PRESENT", countMode: "CAPPED", fields: [] }],
  };
  synthetic.state.mongo = () => partial;
  assert.deepEqual(await verify(), {
    state: "PARTIAL",
    attempt: 1,
    submittedAt: "2026-11-20T12:00:00Z",
    checks: ["PRESENT"],
  });
  synthetic.state.mongo = () => ({ ...partial, cleanup: "FAILED" });
  assert.deepEqual(await verify(), {
    state: "UNKNOWN",
    reason: "PROVIDER_UNAVAILABLE",
  });
  synthetic.state.mongo = () => {
    mongo.students[0].database = "another_practice";
    return partial;
  };
  assert.equal((await check(plan.scope, "MONGODB", student)).status, 409);
  assert.equal(synthetic.state.activeWorkers, 0);
  assert.deepEqual(synthetic.calls.github, []);
});

test("GitHub expiry leaves approved MongoDB verification available and retains the secret reuse guard", async (t) => {
  let now = canvasNow;
  const { synthetic, scope, request, preview, check } = await setup(
    t,
    2,
    () => now,
  );
  const [student] = synthetic.ids;
  const settings = synthetic.configuration;
  settings.github.expiresAt = new Date(now + 1).toISOString();
  const beforeExpiry = await scope();
  now++;

  const plan = await scope();
  assert.deepEqual(plan.assignments, [beforeExpiry.assignments[1]]);
  assert.notEqual(plan.scope, beforeExpiry.scope);
  assert.ok(!JSON.stringify(plan).includes(settings.github.token));
  assert.equal(
    (await preview(beforeExpiry.scope, "MONGODB", student)).status,
    409,
  );
  assert.equal((await preview(plan.scope, "GITHUB", student)).status, 403);
  assert.deepEqual(synthetic.calls.canvas, []);
  assert.deepEqual(synthetic.calls.github, []);
  assert.deepEqual(synthetic.calls.mongo, []);

  synthetic.state.source = (row) => ({
    ...row,
    body: row.body.replace(
      verificationSecretMarker + student,
      settings.github.token,
    ),
  });
  assert.deepEqual(
    await (await preview(plan.scope, "MONGODB", student)).json(),
    {
      state: "BLOCKED",
    },
  );
  assert.deepEqual(synthetic.calls.mongo, []);

  synthetic.state.source = (row) => row;
  assert.deepEqual(await (await check(plan.scope, "MONGODB", student)).json(), {
    state: "OBSERVED",
    attempt: 1,
    submittedAt: "2026-11-20T12:00:00Z",
    checks: ["PRESENT", "PRESENT"],
  });
  assert.deepEqual(synthetic.calls.mongo, [student]);

  const [github] = settings.assignments;
  settings.assignments.push(github);
  assert.equal((await request()).status, 503);
  settings.assignments.pop();
  const previousExpiry = settings.github.expiresAt;
  settings.github.expiresAt = "invalid";
  assert.equal((await request()).status, 503);
  settings.github.expiresAt = previousExpiry;
  settings.assignments = [github];
  assert.equal((await request()).status, 503);
});

test("verification admits one operation and cancels the GitHub request without starting the next row", async (t) => {
  const { synthetic, scope, preview, check } = await setup(t, 2);
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
  const running = check(
    plan.scope,
    "GITHUB",
    synthetic.ids[0],
    controller.signal,
  );
  await Promise.race([
    entered.promise,
    running.then(() =>
      assert.fail("Verification settled before GitHub was called"),
    ),
  ]);
  assert.equal(
    (await preview(plan.scope, "GITHUB", synthetic.ids[1])).status,
    409,
  );
  controller.abort();
  await assert.rejects(running, { name: "AbortError" });
  await stopped.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(synthetic.calls.github, ["/user"]);
});
