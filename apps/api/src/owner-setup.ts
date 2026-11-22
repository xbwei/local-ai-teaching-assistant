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
import { demoUsernames, initializePersistence } from "@laita/persistence";
import { courseIds } from "@laita/course-grounding";
import {
  initializeOwnerCredential,
  verifyOwnerCredential,
} from "./owner-credential.ts";
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
async function confirmedPassphrase(label: string) {
  const passphrase = await hidden(
    `${label} passphrase, at least 15 characters (hidden): `,
  );
  if (passphrase !== (await hidden("Repeat passphrase (hidden): ")))
    throw new Error("Passphrases do not match; no change made.");
  return passphrase;
}
async function main() {
  const [command, arg, extra, ...rest] = process.argv.slice(2);
  const c = configuration();
  if (command === "canvas-xml") {
    if ((arg !== undefined && arg !== "--demo") || extra)
      throw new Error("Use canvas:xml with optional --demo.");
    process.stdout.write(
      canvasXml(c.access.publicOrigin, arg === "--demo") + "\n",
    );
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
    const course = courseIds.find((value) => value === extra);
    if (
      arg !== undefined &&
      (arg !== "--demo-course" || !course || rest.length)
    )
      throw new Error(
        "Use canvas:setup with optional --demo-course IA340 or IA342.",
      );
    const values = {
      enabled: true,
      canvasOrigin: await hidden("Canvas HTTPS origin (hidden): "),
      courseId: await hidden("Canvas numeric course ID (hidden): "),
      userId: await hidden("Instructor numeric Canvas user ID (hidden): "),
      consumerKey: await hidden(
        "Consumer key, at least 16 characters (hidden): ",
      ),
      sharedSecret: await hidden(
        "Shared secret, at least 32 random characters (hidden): ",
      ),
      ...(course && {
        demo: {
          course,
          studentUserId: await hidden(
            "Learner numeric Canvas user ID (hidden): ",
          ),
        },
      }),
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
  if (command !== "owner-setup" && command !== "demo-setup")
    throw new Error(
      "Choose owner-setup, demo-setup, canvas-setup, canvas-xml or canvas-disable.",
    );
  const course = courseIds.find((value) => value === arg);
  if (command === "demo-setup" && (!course || extra))
    throw new Error("Use npm run demo:setup -- IA340 or IA342.");
  if (command === "owner-setup" && arg !== undefined)
    throw new Error("Use npm run owner:setup without arguments.");
  // Check the terminal before opening or migrating any database.
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    throw new Error("Use an interactive Terminal for hidden credential input.");
  const ownerPassphrase = course ? "" : await confirmedPassphrase("Owner");
  const ownerCredential = course
    ? undefined
    : await initializeOwnerCredential(ownerPassphrase);
  const paths = initializeRuntimePaths(c.runtimeRoot!);
  if (!paths.ok) throw new Error("Runtime unavailable.");
  const persistence = initializePersistence(paths.value);
  if (!persistence.ok)
    throw new Error("SQLite unavailable. Stop LAITA before maintenance.");
  try {
    const store = persistence.value.ownerAuth();
    if (course) {
      const admin = store.credential();
      if (!admin)
        throw new Error("Use npm run owner:setup first to initialize Admin.");
      const teacher = await confirmedPassphrase("Demo Teacher");
      const student = await confirmedPassphrase("Demo Student");
      if (
        teacher === student ||
        (await verifyOwnerCredential(teacher, admin)) ||
        (await verifyOwnerCredential(student, admin))
      )
        throw new Error(
          "Use different passphrases for Admin, Demo Teacher and Demo Student.",
        );
      const teacherCredential = await initializeOwnerCredential(teacher);
      const studentCredential = await initializeOwnerCredential(student);
      store.configureDemo(course, teacherCredential, studentCredential);
      process.stderr.write(
        "Demo credentials and default course saved for demo-teacher and demo-student. Existing course grants and History are retained.\n",
      );
    } else if (ownerCredential) {
      for (const username of demoUsernames) {
        const account = store.demoAccount(username);
        if (
          account &&
          (await verifyOwnerCredential(ownerPassphrase, account.credential))
        )
          throw new Error(
            "Use an Owner passphrase distinct from the demo accounts.",
          );
      }
      store.setCredential(ownerCredential);
      process.stderr.write(
        "Owner credential saved for Admin and Owner recovery. Existing Owner sessions are invalidated.\n",
      );
    }
  } finally {
    persistence.value.close();
  }
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
