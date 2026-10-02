import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfiguration } from "@laita/runtime";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
const readyStatus = { contractVersion: "readiness.v1", status: "ready" };

// macOS/Linux development checks only. Each process group is owned by this test.
const root = fileURLToPath(new URL("../", import.meta.url));
const loopback = "127.0.0.1";
const legacyPorts = new Set([3100, 5173, 4173]);
const smokePorts = new Set();

const listen = (server, port) =>
  new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: loopback, port, exclusive: true });
  });

const close = async (server) => {
  if (!server.listening) return;
  const closed = once(server, "close");
  server.close();
  await closed;
};

async function occupyLegacyPort(port) {
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  try {
    await listen(server, port);
    server.unref();
    return { server, connections: () => connections };
  } catch (error) {
    if (error.code === "EADDRINUSE") return null;
    throw error;
  }
}

async function reserveSmokePort() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const server = createServer();
    await listen(server, 0);
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const port = address.port;
    if (legacyPorts.has(port) || smokePorts.has(port)) {
      await close(server);
      continue;
    }
    smokePorts.add(port);
    return { port, release: () => close(server) };
  }
  assert.fail("Could not reserve a unique test-owned loopback port");
}

async function withServer(
  argsForPort,
  cwd,
  markerForPort,
  verifyForPort,
  environmentForPort = () => ({}),
) {
  const runtimeRoot = mkdtempSync(path.join(tmpdir(), "teaching-smoke-"));
  const reservation = await reserveSmokePort();
  const defaults = defaultConfiguration();
  const configuration = {
    ...defaults,
    server: { ...defaults.server, bind: "loopback", port: reservation.port },
    runtimeRoot,
  };
  try {
    await reservation.release();
    await runServer(
      argsForPort(reservation.port),
      cwd,
      markerForPort(reservation.port),
      () => verifyForPort(reservation.port),
      JSON.stringify(configuration),
      environmentForPort(reservation.port),
    );
  } finally {
    await reservation.release();
    rmSync(runtimeRoot, { recursive: true, force: true });
    assert.equal(existsSync(runtimeRoot), false);
  }
}
async function runServer(
  args,
  cwd,
  marker,
  verify,
  configurationJson,
  environment,
) {
  const child = spawn(process.execPath, args, {
    cwd,
    detached: true,
    env: { ...process.env, ...environment, APP_CONFIG_JSON: configurationJson },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exit = once(child, "exit");
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  try {
    for (
      let attempt = 0;
      attempt < 100 && !stripVTControlCharacters(output).includes(marker);
      attempt += 1
    ) {
      assert.equal(
        child.exitCode,
        null,
        "Scaffold process exited before startup",
      );
      await delay(100);
    }
    assert.ok(
      stripVTControlCharacters(output).includes(marker),
      "Scaffold process did not announce startup",
    );
    await verify();
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      process.kill(-child.pid, "SIGTERM");
    const result = await Promise.race([
      exit,
      delay(5000, "timeout", { ref: false }),
    ]);
    if (result === "timeout") {
      process.kill(-child.pid, "SIGKILL");
      await exit;
      assert.fail("Scaffold process did not stop within five seconds");
    }
    // A forced cleanup must fail the check rather than hide an orphaned watcher.
    let groupAlive = true;
    for (let attempt = 0; attempt < 20 && groupAlive; attempt += 1) {
      try {
        process.kill(-child.pid, 0);
        await delay(100);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
        groupAlive = false;
      }
    }
    if (groupAlive) {
      process.kill(-child.pid, "SIGKILL");
      assert.fail("Scaffold left a process in its test-owned group");
    }
    assert.ok(
      result[0] === 0 || result[0] === 143 || result[1] === "SIGTERM",
      `Unexpected process exit: ${JSON.stringify(result)}`,
    );
  }
}

const checkApi = async (port) => {
  // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
  const response = await fetch(`http://${loopback}:${port}/ready`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), readyStatus);
};
const vite = `${root}/node_modules/vite/bin/vite.js`;
const occupiedLegacyPorts = (
  await Promise.all([...legacyPorts].map(occupyLegacyPort))
).filter(Boolean);
try {
  await withServer(
    () => ["dist/main.js"],
    `${root}/apps/api`,
    () => '"event":"API_STARTED"',
    async (apiPort) => {
      await checkApi(apiPort);
      for (const mode of [[], ["preview"]]) {
        await withServer(
          (webPort) => [
            vite,
            ...mode,
            "--host",
            loopback,
            "--port",
            String(webPort),
            "--strictPort",
          ],
          `${root}/apps/web`,
          (webPort) => `${loopback}:${webPort}`,
          async (webPort) => {
            const origin = `http://${loopback}:${webPort}`;
            const page = await fetch(origin, {
              signal: AbortSignal.timeout(5000),
            });
            assert.equal(page.status, 200);
            assert.match(await page.text(), /LAITA/);
            const response = await fetch(`${origin}/ready`, {
              signal: AbortSignal.timeout(5000),
            });
            assert.deepEqual(await response.json(), readyStatus);
          },
          () => ({ LAITA_SMOKE_API_PORT: String(apiPort) }),
        );
      }
    },
  );
  await withServer(
    () => ["--watch", "src/main.ts"],
    `${root}/apps/api`,
    () => '"event":"API_STARTED"',
    checkApi,
  );
  assert.equal(smokePorts.size, 4);
  for (const port of smokePorts) assert.equal(legacyPorts.has(port), false);
  for (const reservation of occupiedLegacyPorts)
    assert.equal(reservation.connections(), 0);
} finally {
  await Promise.all(occupiedLegacyPorts.map(({ server }) => close(server)));
}
console.log(
  "Built API, API watch mode, web development and web preview start/stop passed on test-owned loopback ports.",
);
