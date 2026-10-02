import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrate, migrations } from "../dist/migrations.js";
import { createHistoryRepository } from "../dist/history.js";
const id = () => randomBytes(32).toString("hex");
const begin = (
  store,
  conversation,
  text = "Synthetic complete question",
  inputType = "TYPED",
) => {
  const turn = id();
  store.begin({ id: turn, conversation, text, inputType, correlation: null });
  return turn;
};
const answer = (leg, text = "Complete synthetic answer") => ({
  leg,
  provider: "LOCAL",
  model: "synthetic",
  actualProvider: "LOCAL",
  actualModel: "synthetic",
  status: "COMPLETED",
  text,
  failure: null,
  latencyMs: 10,
});
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "history-test-")),
    file = path.join(root, "test.sqlite");
  let db = new DatabaseSync(file);
  migrate(db);
  const store = createHistoryRepository(db);
  t.after(() => {
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    db,
    store,
    restart() {
      db.close();
      db = new DatabaseSync(file);
      migrate(db);
      const store = createHistoryRepository(db);
      store.recover();
      return store;
    },
  };
}
test("complete typed and voice text, answers, source identity and feedback survive restart; no retention purge", (t) => {
  const f = fixture(t),
    c = id(),
    text = "Complete question ".repeat(200),
    response = "Complete answer ".repeat(2000),
    a = begin(f.store, c, text),
    b = begin(f.store, c, "完整语音转录", "VOICE");
  f.store.result(
    a,
    "interaction-synthetic",
    [answer("run-a", response)],
    "SUCCESS",
  );
  f.store.result(b, "interaction-voice", [answer("run-b")], "SUCCESS");
  f.store.source(a, "IA340", "4", [
    {
      course: "IA340",
      commit: "a".repeat(40),
      path: "lab4.md",
      section: "Requirements",
      url: "https://example.invalid/source",
      excerpt: "EXCERPT_NOT_DIAGNOSTIC",
    },
  ]);
  f.store.feedback(c, a, {
    leg: "run-a",
    vote: "NOT_HELPFUL",
    report: true,
    reason: "Synthetic answer-quality report",
  });
  f.store.review(c, a, {
    review: "NO_ISSUE",
    note: "Reviewed as uncertain",
    suspected: true,
    suspicionReason: "Manual review needed",
  });
  const store = f.restart(),
    turns = store.conversation(c).turns;
  assert.equal(turns[0].text, text);
  assert.equal(turns[0].answers[0].text, response);
  assert.equal(turns[1].text, "完整语音转录");
  assert.equal(turns[0].lab, "4");
  assert.equal(turns[0].sources[0].excerpt, undefined);
  assert.equal(turns[0].review, "NO_ISSUE");
  assert.equal(turns[0].feedback[0].vote, "NOT_HELPFUL");
  begin(store, id(), "New conversation");
  assert.equal(store.conversation(c).turns.length, 2);
});
test("feedback upsert binds exact conversation/turn/Compare leg, owner review remains separate", (t) => {
  const { store } = fixture(t),
    c = id(),
    turn = begin(store, c);
  store.result(
    turn,
    "interaction",
    [
      answer("local"),
      {
        ...answer("cloud"),
        provider: "OPENAI",
        model: "cloud",
        actualProvider: "OPENAI",
        actualModel: "cloud",
      },
    ],
    "SUCCESS",
  );
  const value = { leg: "local", vote: "HELPFUL", report: false, reason: "" };
  for (let i = 0; i < 10; i++) store.feedback(c, turn, value);
  store.feedback(c, turn, {
    ...value,
    leg: "cloud",
    vote: "NOT_HELPFUL",
    reason: "Needs explanation",
  });
  assert.throws(() => store.feedback(id(), turn, value));
  assert.throws(() => store.feedback(c, turn, { ...value, leg: "unknown" }));
  assert.throws(() => store.feedback(c, turn, { ...value, leg: "" }));
  store.feedback(c, turn, {
    leg: "local",
    vote: null,
    report: true,
    reason: "Problem report",
  });
  store.feedback(c, turn, { ...value, vote: "NOT_HELPFUL" });
  assert.equal(
    store.conversation(c).turns[0].feedback.find((f) => f.leg === "local")
      .report,
    true,
  );
  assert.equal(
    store.conversation(c).turns[0].feedback.find((f) => f.leg === "local")
      .reason,
    "Problem report",
  );
  assert.equal(store.conversation(c).turns[0].feedback.length, 2);
  assert.equal(store.conversation(c).turns[0].review, "PENDING");
  const failed = begin(store, c);
  store.outcome(failed, "FAILED");
  store.feedback(c, failed, {
    leg: "",
    vote: null,
    report: true,
    reason: "No answer",
  });
  assert.equal(store.list({ feedback: "REPORT" }).items[0].id, failed);
});
test("cursor pagination and filters reach older records without truncating details; capture recovery is honest", (t) => {
  const f = fixture(t),
    c = id();
  let earliest;
  for (let i = 0; i < 62; i++) {
    const turn = begin(f.store, c, `Question ${i}`);
    earliest ??= turn;
    if (i !== 61)
      f.store.result(
        turn,
        `interaction-${i}`,
        [answer(`leg-${i}`, `Answer ${i}`)],
        "SUCCESS",
      );
  }
  const pages = [];
  let before;
  do {
    const p = f.store.list({ limit: 20, ...(before ? { before } : {}) });
    pages.push(...p.items);
    before = p.next;
  } while (before);
  assert.equal(pages.length, 62);
  assert.equal(new Set(pages.map((r) => r.id)).size, 62);
  assert.equal(pages.at(-1).id, earliest);
  assert.equal(
    f.store.list({
      search: "Answer 0",
      provider: "LOCAL",
      model: "synthetic",
      outcome: "SUCCESS",
    }).items[0].id,
    earliest,
  );
  const recovered = f.restart();
  assert.equal(recovered.list({ outcome: "INTERRUPTED" }).items.length, 1);
  assert.equal(
    recovered.list({ outcome: "INTERRUPTED" }).items[0].recording,
    "INCOMPLETE",
  );
  let after = 0,
    count = 0;
  do {
    const p = recovered.conversation(c, after);
    count += p.turns.length;
    after = p.next;
  } while (after);
  assert.equal(count, 62);
});
test("v3 policy/usage ledger preserved byte-for-byte by additive v4; old SQL checksums unchanged", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  for (const m of migrations.slice(0, 3)) {
    db.exec(m.sql);
    db.prepare("INSERT INTO schema_migrations VALUES (?,?)").run(
      m.version,
      createHash("sha256").update(m.sql).digest("hex"),
    );
    db.exec(`PRAGMA user_version=${m.version}`);
  }
  db.exec(
    "INSERT INTO policy_versions VALUES (1,'{}','synthetic','2026-01-01')",
  );
  const old = db.prepare("SELECT * FROM schema_migrations").all(),
    policy = db.prepare("SELECT * FROM policy_versions").all();
  migrate(db);
  assert.deepEqual(
    db.prepare("SELECT * FROM schema_migrations WHERE version<=3").all(),
    old,
  );
  assert.deepEqual(db.prepare("SELECT * FROM policy_versions").all(), policy);
  migrate(db);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 4);
  db.exec("PRAGMA user_version=5");
  assert.throws(() => migrate(db));
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 5);
});
test("event limit is visible, storage write failures throw, indexed pagination and measured overhead", (t) => {
  const { db, store } = fixture(t),
    c = id(),
    turn = begin(store, c);
  const event = {
    stage: "PLAYBACK",
    outcome: "PLAY_STARTED",
    origin: "BROWSER",
    at: new Date().toISOString(),
  };
  for (let i = 0; i < 256; i++) store.event(turn, event);
  assert.throws(() => store.event(turn, event));
  assert.equal(store.conversation(c).turns[0].recording, "INCOMPLETE");
  const started = performance.now();
  for (let i = 0; i < 100; i++) {
    const turn = begin(store, c);
    store.result(turn, `interaction-${i}`, [answer(`leg-${i}`)], "SUCCESS");
  }
  const writes = performance.now() - started;
  const read = performance.now();
  store.list({ limit: 20 });
  store.conversation(c);
  t.diagnostic(
    `Synthetic 100 begin/result pairs: ${writes.toFixed(1)} ms; list(20)+detail(5): ${(performance.now() - read).toFixed(1)} ms. No production SLA.`,
  );
  assert.match(
    db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM history_turns WHERE conversation=? AND ordinal>? ORDER BY ordinal LIMIT 6",
      )
      .get(c, 0).detail,
    /history_conversation_order/,
  );
  db.exec("PRAGMA query_only=ON");
  assert.throws(() => begin(store, c));
  assert.equal(store.list({ limit: 50 }).items.length, 50);
});

test("problem summaries use recorded signals, never optional pending review; paging preserves all v4 evidence", (t) => {
  const { store, db, restart } = fixture(t);
  const ledger = db
    .prepare("SELECT * FROM schema_migrations ORDER BY version")
    .all();
  const normal = [];
  for (let i = 0; i < 105; i++) {
    const c = id(),
      turn = begin(store, c, `Normal ${i} ${"preview ".repeat(50)}`);
    store.result(
      turn,
      `interaction-${i}`,
      [answer(`leg-${i}`, "DETAIL_ONLY_LONG_ANSWER".repeat(100))],
      "SUCCESS",
    );
    normal.push(turn);
  }
  const make = (name, mutate) => {
    const c = id(),
      turn = begin(store, c, name);
    store.result(turn, `interaction-${name}`, [answer(name)], "SUCCESS");
    mutate(c, turn);
    return turn;
  };
  const tts = make("tts", (_c, turn) =>
    store.event(turn, {
      stage: "TTS",
      outcome: "FAILED",
      origin: "SERVER",
      at: new Date().toISOString(),
    }),
  );
  const report = make("report", (c, turn) =>
    store.feedback(c, turn, {
      leg: "report",
      vote: null,
      report: true,
      reason: "Synthetic report",
    }),
  );
  const dislike = make("dislike", (c, turn) =>
    store.feedback(c, turn, {
      leg: "dislike",
      vote: "NOT_HELPFUL",
      report: false,
      reason: "",
    }),
  );
  const incomplete = make("incomplete", (_c, turn) => store.incomplete(turn));
  const stage = make("stage", (_c, turn) =>
    store.event(turn, {
      stage: "PLAYBACK",
      outcome: "PLAY_BLOCKED",
      origin: "BROWSER",
      at: new Date().toISOString(),
    }),
  );
  const noAnswer = begin(store, id(), "No answer");
  store.outcome(noAnswer, "NO_ANSWER");
  const safety = begin(store, id());
  store.safety(safety);
  const skipped = make("skipped", (_c, turn) =>
    store.event(turn, {
      stage: "TTS",
      outcome: "TTS_SKIPPED_MUTED",
      origin: "BROWSER",
      at: new Date().toISOString(),
    }),
  );
  assert.equal(
    store.list({ problems: true, review: "PENDING" }).items.length,
    7,
  );
  const problems = store.list({ problems: true }).items;
  assert.deepEqual(
    new Set(problems.map((r) => r.id)),
    new Set([tts, report, dislike, incomplete, stage, noAnswer, safety]),
  );
  assert.deepEqual(problems.find((r) => r.id === tts).problemSignals, [
    "TTS_PROBLEM",
  ]);
  assert.equal(problems.find((r) => r.id === tts).outcome, "SUCCESS");
  assert.deepEqual(
    problems.find((r) => r.id === tts).providers.map((p) => ({ ...p })),
    [
      {
        provider: "LOCAL",
        model: "synthetic",
        actualProvider: "LOCAL",
        actualModel: "synthetic",
      },
    ],
  );
  assert.ok(!problems.some((r) => normal.includes(r.id) || r.id === skipped));
  assert.ok(problems.every((r) => r.review === "PENDING"));
  const reopened = restart();
  let before,
    seen = [];
  do {
    const page = reopened.list({
      limit: 20,
      ...(before === undefined ? {} : { before }),
    });
    assert.ok(page.items.length <= 20);
    for (const row of page.items) {
      assert.ok(row.text === null || row.text.length <= 160);
      assert.equal(row.answers, undefined);
      assert.equal(row.events, undefined);
      assert.equal(row.usage, undefined);
    }
    assert.doesNotMatch(JSON.stringify(page), /DETAIL_ONLY_LONG_ANSWER/);
    seen.push(...page.items.map((r) => r.id));
    before = page.next;
  } while (before !== null);
  assert.equal(seen.length, 113);
  assert.equal(new Set(seen).size, 113);
  assert.equal(reopened.list({ problems: true }).items.length, 7);
  // No migration or destructive write is introduced by read/review navigation.
  const connection = new DatabaseSync(":memory:");
  migrate(connection);
  assert.deepEqual(
    connection
      .prepare("SELECT * FROM schema_migrations ORDER BY version")
      .all(),
    ledger,
  );
  connection.close();
});

test("Owner-confirmed problems are distinct from system facts and other optional dispositions", (t) => {
  const { store, restart } = fixture(t);
  const c = id();
  const ids = {};
  for (const review of ["PENDING", "REVIEWED", "NO_ISSUE", "CONFIRMED_ISSUE"]) {
    const turn = begin(store, c, `Clean success with ${review}`);
    ids[review] = turn;
    store.result(turn, `interaction-${review}`, [answer(review)], "SUCCESS");
    store.review(c, turn, {
      review,
      note: "",
      suspected: false,
      suspicionReason: "",
    });
  }
  const failure = begin(store, c, "Successful text with a TTS failure");
  store.result(failure, "interaction-tts", [answer("tts")], "SUCCESS");
  store.event(failure, {
    stage: "TTS",
    outcome: "FAILED",
    origin: "SERVER",
    at: new Date().toISOString(),
  });
  store.review(c, failure, {
    review: "NO_ISSUE",
    note: "Optional opinion",
    suspected: false,
    suspicionReason: "",
  });
  const reopened = restart();
  const all = reopened.list({}).items;
  const problems = reopened.list({ problems: true }).items;
  assert.deepEqual(
    new Set(problems.map((r) => r.id)),
    new Set([ids.CONFIRMED_ISSUE, failure]),
  );
  for (const row of all) {
    const expected =
      row.id === ids.CONFIRMED_ISSUE
        ? ["OWNER_CONFIRMED"]
        : row.id === failure
          ? ["TTS_PROBLEM"]
          : [];
    assert.deepEqual(row.problemSignals, expected);
    assert.equal(
      problems.some((r) => r.id === row.id),
      row.problemSignals.length > 0,
    );
    assert.equal(row.outcome, "SUCCESS");
  }
  assert.deepEqual(
    reopened
      .list({ problems: true, review: "NO_ISSUE" })
      .items.map((r) => r.id),
    [failure],
  );
  // Changing the optional annotation removes only its manual signal.
  reopened.review(c, ids.CONFIRMED_ISSUE, {
    review: "REVIEWED",
    note: "",
    suspected: false,
    suspicionReason: "",
  });
  assert.deepEqual(
    reopened.list({ problems: true }).items.map((r) => r.id),
    [failure],
  );
});

test("deliberate long speech skip is retained without creating a problem; real speech failure stays independent", (t) => {
  const { store } = fixture(t),
    c = id(),
    turn = begin(store, c);
  store.result(
    turn,
    "interaction-synthetic",
    [answer("run-long", "Complete long answer. ".repeat(100))],
    "SUCCESS",
  );
  store.event(turn, {
    stage: "TTS",
    outcome: "SKIPPED_LONG_ANSWER",
    origin: "SERVER",
    at: new Date().toISOString(),
  });
  assert.equal(store.list({ problems: true }).items.length, 0);
  store.event(turn, {
    stage: "TTS",
    outcome: "FAILED",
    origin: "SERVER",
    at: new Date().toISOString(),
  });
  store.event(turn, {
    stage: "TTS",
    outcome: "ADAPTER_FAILED",
    origin: "SERVER",
    at: new Date().toISOString(),
  });
  const result = store.list({ problems: true }).items;
  assert.equal(result.length, 1);
  assert.equal(result[0].outcome, "SUCCESS");
  assert.deepEqual(result[0].problemSignals, ["TTS_PROBLEM"]);
});
