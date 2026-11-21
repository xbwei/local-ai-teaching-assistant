import { Worker } from "node:worker_threads";
import { submissionLinkText } from "./verification-submission.ts";
import type { MongoEvidence } from "@laita/contracts";
import {
  VerificationError,
  verificationDigest,
  verificationId,
} from "./verification-support.ts";

export function validMongoCredential(value: string): boolean {
  if (value.length > 2048) return false;
  try {
    const c = JSON.parse(value);
    return (
      !!c &&
      Object.keys(c).sort().join() === "password,username" &&
      typeof c.username === "string" &&
      /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(c.username) &&
      typeof c.password === "string" &&
      c.password.length >= 1 &&
      c.password.length <= 256 &&
      !/[\u0000-\u001f\u007f]/u.test(c.password)
    );
  } catch {
    return false;
  }
}
export interface MongoExpectation {
  canvasOrigin: string;
  courseId: string;
  teacherId: string;
  studentId: string;
  assignmentId: string;
  host: string;
  database: string;
  collections: {
    name: string;
    fields: {
      path: string;
      type: "string" | "number" | "boolean" | "array" | "object" | "date";
      nonempty: boolean;
    }[];
  }[];
}
export interface MongoConfiguration {
  expectation: MongoExpectation;
  revision: string;
}
export interface MongoSource {
  scheme: "mongodb:" | "mongodb+srv:";
  host: string;
  credential: string;
}
export interface MongoAuthority extends MongoConfiguration {
  // Request-local exact Canvas source; never a persisted credential mapping.
  source: (signal: AbortSignal) => Promise<MongoSource>;
}
export const mongoHost = (host: string) =>
  host.length <= 200 &&
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+\.mongodb\.net$/u.test(
    host,
  );
/** Closed URI grammar, parsed only inside the private Canvas request. Nothing
 * from query options is passed through to the driver. */
export function mongoSubmission(
  body: unknown,
  e: MongoExpectation,
): MongoSource {
  const denied = new VerificationError("MONGO_SECRET_UNAVAILABLE");
  if (typeof body !== "string") throw denied;
  let link: ReturnType<typeof submissionLinkText>;
  try {
    link = submissionLinkText(body);
  } catch {
    throw denied;
  }
  const { text, href } = link;
  if (
    /[<>\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(text) ||
    (text.match(/mongodb(?:\+srv)?:/giu) ?? []).length !== 1
  ) {
    // Conflicting or duplicate connection claims are not guessed.
    throw denied;
  }
  const tokens = text.match(/mongodb(?:\+srv)?:\/\/[^\s]+/gu);
  if (!tokens || tokens.length !== 1 || tokens[0]!.length > 2048) throw denied;
  const raw = tokens[0]!;
  if (href !== undefined && href !== raw) throw denied;
  if (raw.split("@").length !== 2) throw denied;
  if (/[\\#"'`]/u.test(raw) || /%(?![0-9a-f]{2})/iu.test(raw)) throw denied;
  try {
    const u = new URL(raw);
    if (
      !["mongodb:", "mongodb+srv:"].includes(u.protocol) ||
      !mongoHost(u.hostname) ||
      u.hostname !== e.host ||
      (u.port && (u.protocol === "mongodb+srv:" || u.port !== "27017")) ||
      !u.username ||
      !u.password ||
      u.hash ||
      !["", "/", "/" + e.database].includes(u.pathname)
    )
      throw denied;
    const seen = new Set<string>();
    for (const [key, value] of u.searchParams) {
      if (seen.has(key)) throw denied;
      seen.add(key);
      if (!(
        (key === "retryWrites" && ["true", "false"].includes(value)) ||
        (key === "w" && value === "majority") ||
        (key === "appName" && /^[A-Za-z0-9_-]{1,64}$/u.test(value)) ||
        (key === "authSource" && value === "admin") ||
        (["tls", "ssl"].includes(key) && value === "true")
      ))
        throw denied;
    }
    // WHATWG URL accessors retain the percent-encoded user info.
    const credential = JSON.stringify({
      username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
    });
    if (!validMongoCredential(credential)) throw denied;
    return {
      scheme: u.protocol as MongoSource["scheme"],
      host: u.hostname,
      credential,
    };
  } catch {
    throw denied;
  }
}
export const mongoName = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[A-Za-z][A-Za-z0-9_]{0,47}$/u.test(v) &&
  !["admin", "local", "config", "system"].includes(v);
const exact = (v: object, keys: string) =>
  Object.keys(v).sort().join() === keys;
export function validMongoExpectation(e: MongoExpectation): boolean {
  try {
    const origin = new URL(e.canvasOrigin);
    return (
      exact(
        e,
        "assignmentId,canvasOrigin,collections,courseId,database,host,studentId,teacherId",
      ) &&
      origin.protocol === "https:" &&
      origin.origin === e.canvasOrigin &&
      [e.courseId, e.teacherId, e.studentId, e.assignmentId].every(
        verificationId,
      ) &&
      e.teacherId !== e.studentId &&
      typeof e.host === "string" &&
      mongoHost(e.host) &&
      mongoName(e.database) &&
      Array.isArray(e.collections) &&
      e.collections.length > 0 &&
      e.collections.length <= 2 &&
      new Set(e.collections.map((c) => c.name)).size === e.collections.length &&
      e.collections.every(
        (c) =>
          exact(c, "fields,name") &&
          mongoName(c.name) &&
          Array.isArray(c.fields) &&
          c.fields.length > 0 &&
          c.fields.length <= 4 &&
          new Set(c.fields.map((f) => f.path)).size === c.fields.length &&
          c.fields.every(
            (f) =>
              exact(f, "nonempty,path,type") &&
              typeof f.path === "string" &&
              f.path.split(".").length <= 3 &&
              f.path.split(".").every(mongoName) &&
              [
                "string",
                "number",
                "boolean",
                "array",
                "object",
                "date",
              ].includes(f.type) &&
              typeof f.nonempty === "boolean",
          ),
      )
    );
  } catch {
    return false;
  }
}
export type MongoWorkerInput = {
  expectation: MongoExpectation;
  credential: string;
};
export type MongoWorkerAuthorization = "source" | "command";
/** A short-lived thread owns every driver socket. Termination is awaited on all
 * paths, including cancellation/hung cleanup, before returning to the caller. */
export async function mongoWorker(
  input: MongoWorkerInput,
  signal: AbortSignal,
  check: (scope: MongoWorkerAuthorization) => void | Promise<void>,
): Promise<MongoEvidence> {
  signal.throwIfAborted();
  let worker: Worker;
  try {
    worker = new Worker(new URL("./mongodb-worker.js", import.meta.url), {
      workerData: input,
      env: {},
      stdout: true,
      stderr: true,
      resourceLimits: {
        maxOldGenerationSizeMb: 64,
        maxYoungGenerationSizeMb: 8,
        stackSizeMb: 2,
      },
    });
  } catch {
    throw new VerificationError("MONGO_UNAVAILABLE");
  }
  // Never expose driver stdout/stderr or exception bodies. Drain without retention.
  worker.stdout?.resume();
  worker.stderr?.resume();
  let abort: () => void = () => {};
  try {
    return await new Promise<MongoEvidence>((resolve, reject) => {
      const lifecycle = () =>
        reject(new VerificationError("MONGO_UNAVAILABLE"));
      abort = () => reject(new VerificationError("MONGO_CANCELLED"));
      signal.addEventListener("abort", abort, { once: true });
      worker.on(
        "message",
        (message: {
          authorize?: MongoWorkerAuthorization;
          result?: MongoEvidence;
        }) => {
          const scope = message.authorize;
          if (scope) {
            void Promise.resolve()
              .then(() => check(scope))
              .then(() => {
                signal.throwIfAborted();
                worker.postMessage(true);
              })
              .catch(reject);
            return;
          }
          const result = message.result;
          if (!result) return reject(new VerificationError("MONGO_INVALID"));
          if (Buffer.byteLength(JSON.stringify(result)) > 16_384)
            return reject(new VerificationError("MONGO_LIMIT"));
          resolve(result);
        },
      );
      worker.once("error", lifecycle);
      worker.once("exit", lifecycle);
      if (signal.aborted) abort();
    });
  } finally {
    signal.removeEventListener("abort", abort);
    try {
      await worker.terminate();
    } catch {
      throw new VerificationError("MONGO_UNAVAILABLE");
    }
  }
}
export async function verifyMongoDB(
  get: () => MongoAuthority,
  signal: AbortSignal,
  dependencies = { worker: mongoWorker },
): Promise<MongoEvidence> {
  const a = get(),
    e = a.expectation;
  if (!validMongoExpectation(e))
    throw new VerificationError("MONGO_NOT_CONFIGURED");
  const key = verificationDigest([a.revision, e]);
  const check = () => {
    signal.throwIfAborted();
    const c = get();
    if (verificationDigest([c.revision, c.expectation]) !== key)
      throw new VerificationError("STATE_DRIFT");
  };
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(18_000)]);
  const bounded = async <T>(pending: Promise<T>): Promise<T> => {
    let abort: () => void = () => {};
    try {
      return await Promise.race([
        pending,
        new Promise<T>((_, reject) => {
          abort = () =>
            reject(
              new VerificationError(
                signal.aborted ? "MONGO_CANCELLED" : "MONGO_TIMEOUT",
              ),
            );
          deadline.addEventListener("abort", abort, { once: true });
          if (deadline.aborted) abort();
        }),
      ]);
    } finally {
      deadline.removeEventListener("abort", abort);
    }
  };
  try {
    check();
    const source = await bounded(a.source(deadline));
    if (
      source.host !== e.host ||
      !["mongodb:", "mongodb+srv:"].includes(source.scheme) ||
      !validMongoCredential(source.credential)
    )
      throw new VerificationError("MONGO_TARGET_DENIED");
    const sourceKey = verificationDigest(source);
    const verifySource = async (sourceSignal = deadline) => {
      check();
      sourceSignal.throwIfAborted();
      const fresh = await bounded(get().source(sourceSignal));
      check();
      sourceSignal.throwIfAborted();
      if (verificationDigest(fresh) !== sourceKey)
        throw new VerificationError("STATE_DRIFT");
    };
    await verifySource();
    // Worker owns and joins all sockets; do not race cleanup against return.
    // A monitor's in-flight source check must not outlive the worker.
    const workerScope = new AbortController();
    const workerSignal = AbortSignal.any([deadline, workerScope.signal]);
    let result: MongoEvidence;
    try {
      result = await dependencies.worker(
        { expectation: e, credential: source.credential },
        workerSignal,
        (scope) => {
          if (scope === "source") return verifySource(workerSignal);
          check();
          workerSignal.throwIfAborted();
        },
      );
    } finally {
      workerScope.abort();
    }
    await verifySource();
    check();
    deadline.throwIfAborted();
    return result;
  } catch (error) {
    if (deadline.aborted) {
      throw new VerificationError(
        signal.aborted ? "MONGO_CANCELLED" : "MONGO_TIMEOUT",
      );
    }
    if (error instanceof VerificationError) throw error;
    throw new VerificationError("MONGO_UNAVAILABLE");
  }
}
