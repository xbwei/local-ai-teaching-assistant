import assert from "node:assert/strict";
import test from "node:test";
import {
  mongoSubmission,
  validMongoExpectation,
} from "../dist/mongodb-verification.js";
import {
  createMongoClient,
  mongoPublicIPv4,
} from "../dist/mongodb-transport.js";
import { observeMongo } from "../dist/mongodb-worker.js";

const expectation = {
  canvasOrigin: "https://canvas.example.test",
  courseId: "42001",
  teacherId: "73001",
  studentId: "74001",
  assignmentId: "92",
  host: "sample.example.mongodb.net",
  database: "practice",
  collections: [
    {
      name: "items",
      fields: [{ path: "label", type: "string", nonempty: true }],
    },
  ],
};
const mockPassword = "mock-passphrase-for-tests";
const mockUri = `mongodb+srv://sample:${mockPassword}@${expectation.host}/practice`;

test("MongoDB verifier binds exact URI and scope and constructs the pinned read-only Atlas connection without opening sockets", async () => {
  assert.equal(validMongoExpectation(expectation), true);
  const source = mongoSubmission(`<p>${mockUri}</p>`, expectation);
  assert.equal(source.host, expectation.host);
  assert.deepEqual(JSON.parse(source.credential), {
    username: "sample",
    password: mockPassword,
  });
  for (const outside of [
    mockUri.replace(expectation.host, "other.example.mongodb.net"),
    mockUri.replace("/practice", "/unapproved"),
    mockUri.replace(mockPassword + "@", ""),
    mockUri + "?tls=false",
    `<p>${mockUri}</p><p>${mockUri}</p>`,
  ])
    assert.throws(() => mongoSubmission(outside, expectation), {
      message: "MONGO_SECRET_UNAVAILABLE",
    });
  const client = createMongoClient(
    { expectation, credential: source.credential },
    async () => {},
  );
  try {
    assert.equal(client.options.tls, true);
    assert.equal(client.options.rejectUnauthorized, true);
    assert.equal(client.options.checkServerIdentity, undefined);
    assert.equal(client.options.retryReads, false);
    assert.equal(client.options.retryWrites, false);
    assert.equal(client.options.maxPoolSize, 1);
    assert.deepEqual(client.options.compressors, []);
    assert.equal(typeof client.options.srvHostValidator, "function");
    assert.equal(typeof client.options.lookup, "function");
    assert.equal(client.options.connectionType.name, "BoundedConnection");
    for (const address of [
      "127.0.0.1",
      "192.0.0.1",
      "192.0.2.1",
      "192.88.99.1",
      "192.168.0.1",
      "10.0.0.1",
      "::1",
      "169.254.1.1",
    ])
      assert.equal(mongoPublicIPv4(address), false);
    for (const address of ["8.8.8.8", "192.0.1.1", "192.2.1.1"])
      assert.equal(mongoPublicIPv4(address), true);
  } finally {
    await client.close();
  }
});

test("MongoDB credentials are decoded exactly once from both supported URI schemes", () => {
  for (const scheme of ["mongodb", "mongodb+srv"]) {
    for (const [encoded, expected] of [
      ["synthetic%21", "synthetic!"],
      ["synthetic%25", "synthetic%"],
      ["synthetic%2521", "synthetic%21"],
    ]) {
      const { credential } = mongoSubmission(
        `${scheme}://%73ample:${encoded}@${expectation.host}/practice`,
        expectation,
      );
      assert.deepEqual(JSON.parse(credential), {
        username: "sample",
        password: expected,
      });
    }
  }
});

test("MongoDB reads fixed bounded aggregate metadata and closes on all checked observation paths", async () => {
  const commands = [];
  let closed = 0;
  const pureResponse = (rows) => ({ cursor: { id: 0, firstBatch: rows } });
  const observation = await observeMongo(
    expectation,
    {
      async command(database, c) {
        assert.equal(database, "practice");
        assert.equal(c.maxTimeMS, 2000);
        commands.push(c);
        if (c.listCollections) {
          assert.deepEqual(c.filter, { name: "items" });
          assert.equal(c.nameOnly, true);
          return pureResponse([{ name: "items", type: "collection" }]);
        }
        assert.equal(c.aggregate, "items");
        assert.equal(c.allowDiskUse, false);
        assert.deepEqual(c.pipeline[0], {
          $limit: commands.length === 2 ? 1001 : 101,
        });
        return pureResponse(
          commands.length === 2
            ? [{ n: 1001 }]
            : [{ n: 101, present: 101, matching: 101, empty: 0, oversized: 0 }],
        );
      },
      async close() {
        closed++;
      },
    },
    async () => {},
  );
  assert.equal(commands.length, 3);
  assert.equal(closed, 1);
  assert.equal(observation.collections[0].countMode, "CAPPED");
  assert.equal(observation.collections[0].fields[0].mode, "SAMPLED");
  assert.equal(observation.cleanup, "COMPLETE");
  const denied = await observeMongo(
    expectation,
    {
      async command() {
        assert.fail("Denied request must not dispatch");
      },
      async close() {
        throw Error("synthetic cleanup failure");
      },
    },
    async () => {
      throw Error("synthetic authority change");
    },
  );
  assert.equal(denied.connection.status, "UNAVAILABLE");
  assert.equal(denied.cleanup, "FAILED");
});
