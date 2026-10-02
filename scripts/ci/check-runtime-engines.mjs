#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const RANGE_PATTERN = /^>=(\d+(?:\.\d+){0,2}) <(\d+(?:\.\d+){0,2})$/u;
const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/u;

class RuntimeCompatibilityError extends Error {}

function parseVersion(value, label, allowPartial = false) {
  const pattern = allowPartial
    ? /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/u
    : VERSION_PATTERN;
  const match = pattern.exec(value);
  if (!match) throw new RuntimeCompatibilityError(`Invalid ${label} version.`);
  const parts = match.slice(1, 4).map((part) => Number(part ?? 0));
  if (!parts.every(Number.isSafeInteger)) {
    throw new RuntimeCompatibilityError(`Invalid ${label} version.`);
  }
  return parts;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function supportsEngineRange(actualVersion, declaredRange, label) {
  const range = RANGE_PATTERN.exec(declaredRange);
  if (!range) {
    throw new RuntimeCompatibilityError(`Unsupported ${label} engine range.`);
  }
  const actual = parseVersion(actualVersion, label);
  const minimum = parseVersion(range[1], label, true);
  const maximum = parseVersion(range[2], label, true);
  if (compareVersions(minimum, maximum) >= 0) {
    throw new RuntimeCompatibilityError(`Invalid ${label} engine range.`);
  }
  return (
    compareVersions(actual, minimum) >= 0 &&
    compareVersions(actual, maximum) < 0
  );
}

export function validateRuntimeEngines({ nodeVersion, npmVersion, engines }) {
  if (
    !engines ||
    typeof engines.node !== "string" ||
    typeof engines.npm !== "string"
  ) {
    throw new RuntimeCompatibilityError(
      "Runtime engine declarations are missing.",
    );
  }
  if (!supportsEngineRange(nodeVersion, engines.node, "Node")) {
    throw new RuntimeCompatibilityError(
      "Node version is outside the supported runtime range.",
    );
  }
  if (!supportsEngineRange(npmVersion, engines.npm, "npm")) {
    throw new RuntimeCompatibilityError(
      "npm version is outside the supported runtime range.",
    );
  }
}

function runCli() {
  const [npmVersion, ...unknownArguments] = process.argv.slice(2);
  if (!npmVersion || unknownArguments.length > 0) {
    process.stderr.write(
      "Runtime engine compatibility arguments are invalid.\n",
    );
    process.exitCode = 1;
    return;
  }
  try {
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    validateRuntimeEngines({
      nodeVersion: process.versions.node,
      npmVersion,
      engines: manifest.engines,
    });
    process.stdout.write("Runtime engine compatibility passed.\n");
  } catch (error) {
    const reason =
      error instanceof RuntimeCompatibilityError ? `: ${error.message}` : ".";
    process.stderr.write(`Runtime engine compatibility failed${reason}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) runCli();
