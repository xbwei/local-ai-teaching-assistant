import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isAccessConfiguration } from "../dist/configuration-server.js";

const demo = JSON.parse(
  readFileSync(
    new URL("../../runtime/examples/openai-demo.example.json", import.meta.url),
    "utf8",
  ),
).access;
const local = JSON.parse(
  readFileSync(
    new URL("../../runtime/examples/local-only.example.json", import.meta.url),
    "utf8",
  ),
).access;

test("access stages and synthetic localhost/private examples are closed", () => {
  assert.equal(isAccessConfiguration(local), true);
  assert.equal(isAccessConfiguration(demo), true);
  assert.equal(isAccessConfiguration({ ...demo, credentials: [] }), true);
  for (const changed of [
    { ...demo, unknown: true },
    { ...demo, mode: "public-internet" },
    { ...demo, publicOrigin: "http://teaching.example.invalid" },
    { ...demo, publicOrigin: "https://teaching.example.invalid/path" },
    { ...demo, publicOrigin: "https://user@teaching.example.invalid" },
    { ...demo, requireForwardedHttps: false },
    { ...local, publicOrigin: "http://localhost:5173" },
    { ...local, requireForwardedHttps: true },
    { ...demo, adminCredentials: [] },
    {
      ...demo,
      mode: "institution-approved",
      enabled: true,
    },
  ])
    assert.equal(isAccessConfiguration(changed), false);
  assert.equal(
    isAccessConfiguration({
      ...demo,
      mode: "institution-approved",
      enabled: false,
      credentials: [],
      adminCredentials: [],
    }),
    true,
  );
});

test("credential verifiers, roles, course scopes, expiry and revocation are bounded", () => {
  const candidate = structuredClone(demo);
  const original = candidate.credentials[0];
  for (const changed of [
    { ...original, id: "UPPER" },
    { ...original, role: "admin" },
    { ...original, courseScopes: [] },
    { ...original, courseScopes: ["Synthetic"] },
    { ...original, tokenSha256: "0".repeat(63) },
    { ...original, tokenSha256: "g".repeat(64) },
    { ...original, expiresAtEpochSeconds: 0 },
    { ...original, expiresAtEpochSeconds: "4102444800" },
    { ...original, revoked: "false" },
    { ...original, token: "synthetic-cleartext" },
  ])
    assert.equal(
      isAccessConfiguration({ ...candidate, credentials: [changed] }),
      false,
    );
  assert.equal(
    isAccessConfiguration({
      ...candidate,
      adminCredentials: [{ ...candidate.adminCredentials[0], id: original.id }],
    }),
    false,
  );
  assert.equal(
    isAccessConfiguration({
      ...candidate,
      adminCredentials: [
        {
          ...candidate.adminCredentials[0],
          tokenSha256: original.tokenSha256,
        },
      ],
    }),
    false,
  );
});
