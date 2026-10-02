#!/usr/bin/env node

import { runOpenAILiveHarness } from "./openai-live-harness.ts";

const CONFIRM_ARGUMENT = "--confirm-live";
const allowedArguments = new Set([CONFIRM_ARGUMENT]);
const unknownArguments = process.argv
  .slice(2)
  .filter((entry) => !allowedArguments.has(entry));

if (unknownArguments.length > 0) {
  process.stderr.write("OpenAI live harness rejected unknown arguments.\n");
  process.exitCode = 2;
} else {
  try {
    const service = process.env.LAITA_OPENAI_KEYCHAIN_SERVICE;
    const account = process.env.LAITA_OPENAI_KEYCHAIN_ACCOUNT;
    const evidence = await runOpenAILiveHarness({
      confirmed: process.argv.includes(CONFIRM_ARGUMENT),
      ...(service === undefined || account === undefined
        ? {}
        : { keychain: { service, account } }),
    });
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    process.stderr.write(`${evidence.summary}\n`);
    process.exitCode =
      evidence.status === "PASS" ? 0 : evidence.status === "NOT_RUN" ? 2 : 1;
  } catch {
    process.stderr.write("OpenAI live harness configuration was rejected.\n");
    process.exitCode = 2;
  }
}
