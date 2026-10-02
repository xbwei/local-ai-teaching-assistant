import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { OpenAIConfigurationError } from "../dist/index.js";
import {
  OPENAI_LIVE_MODEL,
  runOpenAILiveHarness,
} from "../dist/openai-live-harness.js";

const syntheticSecret = `sk-live_${"z".repeat(32)}`;
const service = "synthetic-live-service";
const account = "synthetic-live-account";
const prompt =
  "Return the integers 1 through 32 in order, separated by single spaces, and no other text.";

function response(output = "1 2 3 4") {
  return {
    id: "resp_synthetic_live",
    object: "response",
    created_at: 1,
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: 64,
    model: OPENAI_LIVE_MODEL,
    output: [
      {
        id: "msg_synthetic_live",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: output,
            annotations: [],
            logprobs: [],
          },
        ],
      },
    ],
    parallel_tool_calls: false,
    previous_response_id: null,
    reasoning: { effort: "none", summary: null },
    store: false,
    temperature: 0,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: 0.9,
    truncation: "disabled",
    usage: {
      input_tokens: 12,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 4,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 16,
    },
    metadata: {},
  };
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(outgoing, status, value) {
  outgoing.writeHead(status, { "content-type": "application/json" });
  outgoing.end(JSON.stringify(value));
}

function sse(outgoing, event) {
  outgoing.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

async function mockOpenAI(t) {
  const state = {
    calls: 0,
    streamCalls: 0,
    transportAborts: 0,
    prompts: [],
  };
  const server = http.createServer(async (incoming, outgoing) => {
    state.calls += 1;
    incoming.on("aborted", () => {
      state.transportAborts += 1;
    });
    const payload = await body(incoming);
    state.prompts.push(payload.input);
    const authorization = incoming.headers.authorization ?? "";
    if (authorization.includes("invalid")) {
      return json(outgoing, 401, {
        error: {
          message: "synthetic upstream authentication failure",
          type: "invalid_request_error",
          param: null,
          code: "invalid_api_key",
        },
      });
    }
    if (!payload.stream) {
      if (state.calls === 4) {
        return setTimeout(() => {
          if (!outgoing.destroyed) json(outgoing, 200, response());
        }, 100);
      }
      return json(outgoing, 200, response());
    }
    state.streamCalls += 1;
    outgoing.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    sse(outgoing, {
      type: "response.output_text.delta",
      sequence_number: 1,
      item_id: "msg_synthetic_live",
      output_index: 0,
      content_index: 0,
      delta: "1 2 ",
      logprobs: [],
      obfuscation: "fixture",
    });
    const finish = () => {
      if (outgoing.destroyed) return;
      sse(outgoing, {
        type: "response.output_text.delta",
        sequence_number: 2,
        item_id: "msg_synthetic_live",
        output_index: 0,
        content_index: 0,
        delta: "3 4",
        logprobs: [],
        obfuscation: "fixture",
      });
      sse(outgoing, {
        type: "response.completed",
        sequence_number: 3,
        response: response(),
      });
      outgoing.end("data: [DONE]\n\n");
    };
    if (state.streamCalls === 2) setTimeout(finish, 100);
    else finish();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return { state, baseURL: `http://127.0.0.1:${address.port}` };
}

function keychainRunner(
  state,
  result = { exitCode: 0, stdout: syntheticSecret },
) {
  return async (executable, args, options) => {
    state.calls += 1;
    assert.equal(executable, "/usr/bin/security");
    assert.deepEqual(args, [
      "find-generic-password",
      "-w",
      "-s",
      service,
      "-a",
      account,
    ]);
    assert.equal(options.maxOutputBytes, 4096);
    assert.equal(options.timeoutMs, 1000);
    return result;
  };
}

test("live harness is opt-in and performs no Keychain or provider work when unconfirmed", async () => {
  let calls = 0;
  const evidence = await runOpenAILiveHarness({
    confirmed: false,
    testBaseURL: "https://example.com",
    keychainCommandRunner: async () => {
      calls += 1;
      return { exitCode: 0, stdout: syntheticSecret };
    },
  });
  assert.equal(evidence.status, "NOT_RUN");
  assert.equal(evidence.cleanup.status, "NOT_RUN");
  assert.equal(calls, 0);
});

test("missing runtime options fail closed as an unconfirmed no-op", async () => {
  for (const options of [undefined, null]) {
    const evidence = await runOpenAILiveHarness(options);
    assert.equal(evidence.status, "NOT_RUN");
    assert.equal(evidence.tests.length, 0);
    assert.equal(evidence.cleanup.status, "NOT_RUN");
  }
});

test("confirmed live harness requires a protected Keychain mapping", async () => {
  await assert.rejects(
    runOpenAILiveHarness({ confirmed: true }),
    OpenAIConfigurationError,
  );
});

test("CLI rejects arbitrary arguments before any live run", () => {
  const result = spawnSync(
    process.execPath,
    [
      new URL("../dist/openai-live-cli.js", import.meta.url).pathname,
      "--confirm-live",
      "--model=arbitrary",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /rejected unknown arguments/);
  assert.equal(result.stdout, "");
});

test("CLI without explicit confirmation performs no configured live run", () => {
  const environment = { ...process.env };
  delete environment.LAITA_OPENAI_KEYCHAIN_SERVICE;
  delete environment.LAITA_OPENAI_KEYCHAIN_ACCOUNT;
  const result = spawnSync(
    process.execPath,
    [new URL("../dist/openai-live-cli.js", import.meta.url).pathname],
    { encoding: "utf8", env: environment },
  );
  assert.equal(result.status, 2);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.status, "NOT_RUN");
  assert.match(result.stderr, /not explicitly confirmed/);
});

test("Keychain-backed live sequence returns only sanitized bounded evidence", async (t) => {
  const upstream = await mockOpenAI(t);
  const keychain = { calls: 0 };
  const evidence = await runOpenAILiveHarness({
    confirmed: true,
    keychain: { service, account },
    keychainCommandRunner: keychainRunner(keychain),
    testBaseURL: upstream.baseURL,
    operationTimeoutMs: 1000,
    timeoutProbeMs: 10,
  });
  assert.equal(evidence.status, "PASS", JSON.stringify(evidence));
  assert.equal(evidence.model, OPENAI_LIVE_MODEL);
  assert.equal(evidence.tests.length, 6);
  assert.equal(keychain.calls, 4);
  assert.equal(upstream.state.calls, 5);
  assert.equal(upstream.state.streamCalls, 2);
  assert.deepEqual(upstream.state.prompts[0], [
    { role: "user", content: prompt },
  ]);

  const byName = new Map(evidence.tests.map((entry) => [entry.test, entry]));
  assert.equal(
    byName.get("missing-secret-isolation").outcome,
    "PROVIDER_UNAVAILABLE",
  );
  assert.equal(
    byName.get("keychain-non-stream").actualModel,
    OPENAI_LIVE_MODEL,
  );
  assert.equal(byName.get("keychain-non-stream").usage.providerReported, true);
  assert.equal(byName.get("stream").deltaCount, 2);
  assert.equal(byName.get("cancellation").outcome, "CANCELLED");
  assert.equal(byName.get("timeout").outcome, "TIMEOUT");
  assert.equal(
    byName.get("authentication-failure-isolation").outcome,
    "PROVIDER_AUTHENTICATION_FAILED",
  );

  const serialized = JSON.stringify(evidence);
  for (const prohibited of [
    syntheticSecret,
    service,
    account,
    prompt,
    "1 2 3 4",
    upstream.baseURL,
    "authorization",
  ]) {
    assert.equal(serialized.includes(prohibited), false, prohibited);
  }
});

test("Keychain failure stops safely with no prompt, response, or identifier evidence", async (t) => {
  const upstream = await mockOpenAI(t);
  const keychain = { calls: 0 };
  const evidence = await runOpenAILiveHarness({
    confirmed: true,
    keychain: { service, account },
    keychainCommandRunner: keychainRunner(keychain, {
      exitCode: 44,
      stdout: "",
    }),
    testBaseURL: upstream.baseURL,
    operationTimeoutMs: 1000,
  });
  assert.equal(evidence.status, "FAIL");
  assert.equal(keychain.calls, 1);
  assert.equal(upstream.state.calls, 0);
  assert.equal(evidence.cleanup.status, "PASS");
  assert.equal(evidence.cleanup.temporaryStateRetained, false);
  assert.equal(evidence.tests.at(-1).outcome, "PROVIDER_UNAVAILABLE");
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes(service), false);
  assert.equal(serialized.includes(account), false);
  assert.equal(serialized.includes(prompt), false);
});

test("harness source has no persistence, Local fallback, prompt logging, or production endpoint override", async () => {
  const [harness, cli] = await Promise.all([
    readFile(new URL("../src/openai-live-harness.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/openai-live-cli.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(
    harness,
    /SQLite|interaction-store|console\.|process\.stdout/,
  );
  assert.doesNotMatch(harness, /OllamaLocalAdapter|from ["'].+ollama/i);
  assert.doesNotMatch(cli, /BASE_URL|ENDPOINT|API_KEY|OPENAI_API_KEY/);
  assert.match(cli, /LAITA_OPENAI_KEYCHAIN_SERVICE/);
  assert.match(cli, /LAITA_OPENAI_KEYCHAIN_ACCOUNT/);
});
