import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import {
  constants,
  openSync,
  closeSync,
  writeFileSync,
  lstatSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { loadConfiguration, initializeRuntimePaths } from "@laita/runtime";
import { initializePersistence } from "@laita/persistence";
import { initializeOwnerCredential } from "./owner-credential.ts";
import {
  assertCanvasDirectory,
  canvasXml,
  validateCanvasConfiguration,
} from "./canvas.ts";

/** Terminal-only secret input; no command-line/env password, echo or redirected stdin. */
async function hidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    throw new Error("Use an interactive Terminal for hidden credential input.");
  const muted = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const reader = createInterface({
    input: process.stdin,
    output: muted,
    terminal: true,
    historySize: 0,
  });
  process.stderr.write(prompt);
  const abort = new AbortController();
  reader.once("SIGINT", () => abort.abort());
  try {
    return await reader.question("", { signal: abort.signal });
  } finally {
    reader.close();
    muted.end();
    process.stderr.write("\n");
  }
}
function configuration() {
  const c = loadConfiguration(process.env);
  if (
    !c.ok ||
    c.value.mode !== "operator" ||
    c.value.access.mode !== "single-operator" ||
    !c.value.runtimeRoot
  )
    throw new Error("Load your operator APP_CONFIG_JSON first.");
  return c.value;
}
function canvasFile(): string {
  const file = process.env.LAITA_CANVAS_CONFIG_FILE;
  if (!file || !path.isAbsolute(file))
    throw new Error(
      "Set LAITA_CANVAS_CONFIG_FILE to an absolute file outside Git, in an owner-only directory.",
    );
  assertCanvasDirectory(file);
  return file;
}
async function main() {
  const command = process.argv[2];
  const c = configuration();
  if (command === "canvas-xml") {
    process.stdout.write(canvasXml(c.access.publicOrigin) + "\n");
    return;
  }
  if (command === "canvas-disable") {
    const file = canvasFile();
    const st = lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid?.())
      throw new Error("Unavailable Canvas configuration.");
    unlinkSync(file);
    process.stderr.write(
      "Canvas disabled. Existing Canvas sessions fail closed; standalone access and History are retained.\n",
    );
    return;
  }
  if (command === "canvas-setup") {
    const file = canvasFile();
    const values = {
      enabled: true,
      canvasOrigin: await hidden("Canvas HTTPS origin (hidden): "),
      courseId: await hidden("Canvas numeric course ID (hidden): "),
      userId: await hidden("Owner numeric Canvas user ID (hidden): "),
      consumerKey: await hidden(
        "Consumer key, at least 16 characters (hidden): ",
      ),
      sharedSecret: await hidden(
        "Shared secret, at least 32 random characters (hidden): ",
      ),
    };
    const config = validateCanvasConfiguration(values);
    const fd = openSync(
      file,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, JSON.stringify(config) + "\n");
    } finally {
      closeSync(fd);
      config.sharedSecret = "";
    }
    process.stderr.write(
      "Canvas configuration saved privately. No credentials were printed.\n",
    );
    return;
  }
  if (command !== "owner-setup")
    throw new Error(
      "Choose owner-setup, canvas-setup, canvas-xml or canvas-disable.",
    );
  let passphrase = await hidden(
    "Owner passphrase, at least 15 characters (hidden): ",
  );
  let confirmation = await hidden("Repeat passphrase (hidden): ");
  if (passphrase !== confirmation)
    throw new Error("Passphrases do not match; no change made.");
  const material = await initializeOwnerCredential(passphrase);
  passphrase = "";
  confirmation = "";
  const paths = initializeRuntimePaths(c.runtimeRoot!);
  if (!paths.ok) throw new Error("Runtime unavailable.");
  const persistence = initializePersistence(paths.value);
  if (!persistence.ok)
    throw new Error("SQLite unavailable. Stop LAITA before maintenance.");
  try {
    persistence.value.ownerAuth().setCredential(material);
  } finally {
    persistence.value.close();
  }
  process.stderr.write(
    "Owner credential initialized for Admin / Teacher / Student. Existing role sessions are invalidated.\n",
  );
}
main().catch((error: unknown) => {
  // Validation messages are authored here; never print file, JSON, SQL or raw errors.
  const message =
    error instanceof Error &&
    /^(Use |Load |Set |Canvas configuration directory |Keep |Passphrases |Choose )/u.test(
      error.message,
    )
      ? error.message
      : "Setup unavailable; check configuration and owner-only file permissions. No secret details are logged.";
  process.stderr.write(message + "\n");
  process.exitCode = 1;
});
