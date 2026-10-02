#!/usr/bin/env node

import { runOllamaLiveHarness } from "./ollama-live-harness.ts";
import { sampleMacOllamaResources } from "./ollama-live-resources.ts";

const CONFIRM_ARGUMENT = "--confirm-live";
const allowedArguments = new Set([CONFIRM_ARGUMENT]);
const unknownArguments = process.argv
  .slice(2)
  .filter((entry) => !allowedArguments.has(entry));

if (unknownArguments.length > 0) {
  process.stderr.write("Ollama live harness rejected unknown arguments.\n");
  process.exitCode = 2;
} else {
  try {
    const endpoint = process.env.LAITA_OLLAMA_LIVE_ENDPOINT;
    const evidence = await runOllamaLiveHarness({
      confirmed: process.argv.includes(CONFIRM_ARGUMENT),
      ...(endpoint === undefined ? {} : { endpoint }),
      sampleResources: sampleMacOllamaResources,
    });
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    process.stderr.write(`${evidence.summary}\n`);
    process.exitCode =
      evidence.status === "PASS" ? 0 : evidence.status === "NOT_RUN" ? 2 : 1;
  } catch {
    process.stderr.write("Ollama live harness configuration was rejected.\n");
    process.exitCode = 2;
  }
}
