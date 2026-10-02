import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  checkRuntimeContract,
  renderRuntimeContract,
} from "./generate-runtime-contract.mjs";

const sourceRoot = join(dirname(new URL(import.meta.url).pathname), "..");
const sourceFiles = [
  "types/policy-v1.ts",
  "schemas/v1/common.schema.json",
  "schemas/v1/capability-evaluation.schema.json",
  "schemas/v1/capability-decision.schema.json",
  "policies/v1/policy-bundle.json",
  "policies/v1/data-classification.policy.json",
  "policies/v1/provider-eligibility.policy.json",
  "fixtures/v1/capability-decisions.json",
  "demo/v2/demo-profile.json",
  "demo/v2/provider-eligibility.policy.json",
  "demo/v4/demo-profile.json",
  "demo/v4/provider-eligibility.policy.json",
  "demo/v4/comparison-seed.json",
];

test("runtime contract generation is deterministic and detects source drift", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "laita-policy-runtime-link-"));
  try {
    for (const relative of sourceFiles) {
      const target = join(fixture, relative);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await readFile(join(sourceRoot, relative)));
    }
    const output = join(fixture, "generated.ts");
    await writeFile(output, await renderRuntimeContract(fixture));
    await checkRuntimeContract(fixture, output);

    const providerPath = join(
      fixture,
      "policies/v1/provider-eligibility.policy.json",
    );
    const provider = JSON.parse(await readFile(providerPath, "utf8"));
    provider.allowRules[0].models.push("drifted-model");
    await writeFile(providerPath, `${JSON.stringify(provider, null, 2)}\n`);

    await assert.rejects(
      checkRuntimeContract(fixture, output),
      /missing or drifted/,
    );
  } finally {
    await rm(fixture, { recursive: true });
  }
});

test("runtime generation rejects weakened no-fallback source", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "laita-policy-no-fallback-"));
  try {
    for (const relative of sourceFiles) {
      const target = join(fixture, relative);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await readFile(join(sourceRoot, relative)));
    }
    const providerPath = join(
      fixture,
      "policies/v1/provider-eligibility.policy.json",
    );
    const provider = JSON.parse(await readFile(providerPath, "utf8"));
    provider.fallback = "ALLOWED";
    await writeFile(providerPath, JSON.stringify(provider));
    await assert.rejects(
      renderRuntimeContract(fixture),
      /no-fallback invariant is invalid/,
    );
  } finally {
    await rm(fixture, { recursive: true });
  }
});

test("runtime capability behavior cannot detach from the reviewed demo policy", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "laita-demo-policy-link-"));
  try {
    for (const relative of sourceFiles) {
      const target = join(fixture, relative);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await readFile(join(sourceRoot, relative)));
    }
    const output = join(fixture, "generated.ts");
    const original = await renderRuntimeContract(fixture);
    await writeFile(output, original);
    const providerPath = join(
      fixture,
      "demo/v2/provider-eligibility.policy.json",
    );
    const provider = JSON.parse(await readFile(providerPath, "utf8"));
    provider.allowRules = provider.allowRules.filter(
      (rule) => rule.provider !== "OPENAI",
    );
    await writeFile(providerPath, `${JSON.stringify(provider, null, 2)}\n`);

    const changed = await renderRuntimeContract(fixture);
    assert.notEqual(changed, original);
    assert.doesNotMatch(changed.split("  successor:")[0], /OPENAI_INSTRUCTOR_SYNTHETIC_DEMO/);
    await assert.rejects(
      checkRuntimeContract(fixture, output),
      /missing or drifted/,
    );
  } finally {
    await rm(fixture, { recursive: true });
  }
});

test("runtime linkage is stable across CRLF checkouts and generated files", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "laita-policy-crlf-link-"));
  try {
    for (const relative of sourceFiles) {
      const target = join(fixture, relative);
      await mkdir(dirname(target), { recursive: true });
      const content = await readFile(join(sourceRoot, relative), "utf8");
      await writeFile(target, content.replace(/\n/g, "\r\n"));
    }
    const output = join(fixture, "generated.ts");
    const generated = await renderRuntimeContract(fixture);
    assert.equal(generated, await renderRuntimeContract(sourceRoot));
    await writeFile(output, generated.replace(/\n/g, "\r\n"));
    await checkRuntimeContract(fixture, output);
  } finally {
    await rm(fixture, { recursive: true });
  }
});
