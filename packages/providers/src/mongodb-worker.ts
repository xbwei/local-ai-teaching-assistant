import { createMongoClient, mongoTopologyDenied } from "./mongodb-transport.ts";
import { validMongoExpectation } from "./mongodb-verification.ts";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import type { MongoClient, Document } from "mongodb";
import type {
  MongoEvidence,
  MongoObservation,
  MongoCollectionEvidence,
} from "@laita/contracts";
import type {
  MongoWorkerInput,
  MongoWorkerAuthorization,
  MongoExpectation,
} from "./mongodb-verification.ts";

const collectionFailureCodes = new Set<unknown>([13, 50, 59, 115, "INVALID"]);
const unchecked = (): MongoObservation => ({
  status: "UNCHECKED",
  reason: "NOT_RUN",
});
function mongoErrorCode(error: unknown): unknown {
  if (!error || typeof error !== "object") return;
  return Object.getOwnPropertyDescriptor(error, "code")?.value;
}
function failure(error: unknown): MongoObservation {
  const code = mongoErrorCode(error);
  if (code === "LIMIT") return { status: "PARTIAL", reason: "LIMIT" };
  if (code === "INVALID") return { status: "UNAVAILABLE", reason: "INVALID" };
  if (code === 13 || code === 18) return { status: "DENIED", reason: "ACCESS" };
  if (code === 50) return { status: "UNAVAILABLE", reason: "TIMEOUT" };
  if (code === 59 || code === 115)
    return { status: "UNSUPPORTED", reason: "INVALID" };
  return { status: "UNAVAILABLE", reason: "UNKNOWN" };
}
/** Small fakeable driver surface; no caller supplies commands or pipelines. */
export interface MongoReader {
  command(database: string, command: Document): Promise<Document>;
  close(): Promise<void>;
}
export async function observeMongo(
  e: MongoExpectation,
  reader: MongoReader,
  authorize: () => Promise<void>,
): Promise<MongoEvidence> {
  if (!validMongoExpectation(e)) throw Error("INVALID");
  const result: MongoEvidence = {
    connection: unchecked(),
    database: unchecked(),
    collections: e.collections.map((c) => ({
      collection: c.name,
      ...unchecked(),
      fields: [],
    })),
    cleanup: "COMPLETE",
  };
  let requests = 0,
    bytes = 0;
  const commandError = (code: "INVALID" | "LIMIT") =>
    Object.assign(Error(code), { code });
  const command = async (database: string, c: Document) => {
    await authorize();
    if (++requests > 16 || bytes >= 128 * 1024) throw commandError("LIMIT");
    const r = await reader.command(database, { ...c, maxTimeMS: 2000 });
    bytes += Buffer.byteLength(JSON.stringify(r));
    if (bytes > 128 * 1024) throw commandError("LIMIT");
    return r;
  };
  const cursor = async (c: Document) => {
    const r = await command(e.database, c),
      cur = r.cursor;
    if (
      !cur ||
      !Array.isArray(cur.firstBatch) ||
      cur.firstBatch.length > 1 ||
      String(cur.id) !== "0"
    )
      throw commandError("INVALID");
    return cur.firstBatch as Document[];
  };
  const finite = (v: unknown, max = 1001): number => {
    if (!Number.isSafeInteger(v) || Number(v) < 0 || Number(v) > max)
      throw commandError("INVALID");
    return Number(v);
  };
  try {
    await authorize();
    for (let i = 0; i < e.collections.length; i++) {
      const expected = e.collections[i]!,
        out = result.collections[i]!;
      try {
        const list = await cursor({
          listCollections: 1,
          filter: { name: expected.name },
          nameOnly: true,
          authorizedCollections: false,
          cursor: { batchSize: 2 },
        });
        result.connection = { status: "PRESENT" };
        if (
          list.some((v) => v.name !== expected.name || v.type !== "collection")
        ) {
          out.status = "UNSUPPORTED";
          out.reason = "INVALID";
          continue;
        }
        delete out.reason;
        if (!list.length) {
          out.status = "MISSING";
          continue;
        }
        out.status = "PRESENT";
        result.database = { status: "PRESENT" };
        try {
          const rows = await cursor({
            aggregate: expected.name,
            pipeline: [{ $limit: 1001 }, { $count: "n" }],
            cursor: { batchSize: 2 },
            allowDiskUse: false,
          });
          out.count = rows.length ? finite(rows[0]!.n) : 0;
          out.countMode = out.count === 1001 ? "CAPPED" : "EXACT";
          if (!out.count) out.status = "EMPTY";
        } catch (error) {
          out.status = "PARTIAL";
          out.reason = failure(error).reason ?? "UNKNOWN";
        }
        for (const field of expected.fields) {
          const f: MongoCollectionEvidence["fields"][number] = {
            field: field.path,
            expectedType: field.type,
            nonempty: field.nonempty,
            mode: "SAMPLED",
            inspected: 0,
            present: 0,
            matchingType: 0,
            empty: 0,
            ...unchecked(),
          };
          out.fields.push(f);
          try {
            // Fixed bounded projection: values never cross the DB wire. Oversized
            // source documents contribute only a limit count, independently per field.
            const p = `$${field.path}`,
              type = { $type: p },
              safe = { $lte: [{ $bsonSize: "$$ROOT" }, 32768] };
            const match =
              field.type === "number"
                ? { $in: [type, ["int", "long", "double", "decimal"]] }
                : { $eq: [type, field.type] };
            const empty = {
              $switch: {
                branches: [
                  {
                    case: { $eq: [type, "string"] },
                    then: { $eq: [{ $strLenCP: { $trim: { input: p } } }, 0] },
                  },
                  {
                    case: { $eq: [type, "array"] },
                    then: { $eq: [{ $size: p }, 0] },
                  },
                  {
                    case: { $eq: [type, "object"] },
                    then: { $eq: [{ $size: { $objectToArray: p } }, 0] },
                  },
                ],
                default: false,
              },
            };
            const bit = (condition: Document) => ({
              $cond: [{ $and: [safe, condition] }, 1, 0],
            });
            const rows = await cursor({
              aggregate: expected.name,
              pipeline: [
                { $limit: 101 },
                {
                  $project: {
                    _id: 0,
                    p: bit({ $ne: [type, "missing"] }),
                    t: bit(match),
                    empty: { $cond: [safe, { $cond: [empty, 1, 0] }, 0] },
                    oversized: { $cond: [safe, 0, 1] },
                  },
                },
                {
                  $group: {
                    _id: null,
                    n: { $sum: 1 },
                    present: { $sum: "$p" },
                    matching: { $sum: "$t" },
                    empty: { $sum: "$empty" },
                    oversized: { $sum: "$oversized" },
                  },
                },
              ],
              cursor: { batchSize: 2 },
              allowDiskUse: false,
            });
            const r = rows[0] ?? {
              n: 0,
              present: 0,
              matching: 0,
              empty: 0,
              oversized: 0,
            };
            f.inspected = finite(r.n, 101);
            f.present = finite(r.present, f.inspected);
            f.matchingType = finite(r.matching, f.present);
            f.empty = finite(r.empty, f.present);
            const oversized = finite(r.oversized, f.inspected);
            f.mode = f.inspected === 101 ? "SAMPLED" : "EXACT";
            delete f.reason;
            f.status = oversized
              ? "PARTIAL"
              : !f.inspected
                ? "EMPTY"
                : !f.present
                  ? "MISSING"
                  : f.matchingType !== f.inspected ||
                      (f.nonempty && f.empty > 0)
                    ? "PARTIAL"
                    : "PRESENT";
            if (oversized) f.reason = "LIMIT";
          } catch (error) {
            Object.assign(f, failure(error));
            out.status = "PARTIAL";
          }
        }
      } catch (error) {
        const code = mongoErrorCode(error);
        // Before any successful observation, authentication/transport failure is
        // source-wide. Collection-specific authorization/timeout/unsupported
        // responses may still leave an independent approved collection readable.
        if (
          result.connection.status !== "PRESENT" &&
          !collectionFailureCodes.has(code)
        )
          throw error;
        const observation = failure(error);
        if (result.connection.status !== "PRESENT")
          result.connection = observation;
        Object.assign(out, observation);
      }
    }
    // Recheck exact source authority after observations. Credential roles are
    // deliberately not inspected; only these fixed read operations are reachable.
    await authorize();
  } catch (error) {
    result.connection = failure(error);
    result.database = unchecked();
    result.collections = e.collections.map((c) => ({
      collection: c.name,
      ...unchecked(),
      fields: [],
    }));
  } finally {
    try {
      await reader.close();
    } catch {
      result.cleanup = "FAILED";
    }
  }
  return result;
}
if (!isMainThread) {
  const input = workerData as MongoWorkerInput;
  let client: MongoClient | undefined;
  const topology = new AbortController();
  // Polling SDAM runs in the driver's monitor promise. A guard aborts the
  // observed operation and its finally closes the driver. Only consume its
  // matching callback rejection in this single-operation worker.
  process.on("unhandledRejection", (error) => {
    if (error !== mongoTopologyDenied) throw error;
  });
  // Driver monitors can request lookups in parallel with an application command.
  // Serialize the worker's authorization messages so replies cannot cross.
  let authorization = Promise.resolve();
  const authorize = (scope: MongoWorkerAuthorization) => {
    const authorized = authorization.then(
      () =>
        new Promise<void>((resolve, reject) => {
          parentPort!.once("message", (m) =>
            m === true ? resolve() : reject(Error("DENIED")),
          );
          parentPort!.postMessage({ authorize: scope });
        }),
    );
    // Report an individual denial to its caller while keeping the queue usable.
    authorization = authorized.catch(() => {});
    return authorized;
  };
  try {
    client = createMongoClient(input, () => authorize("source"), topology);
    const driver = client;
    const result = await observeMongo(
      input.expectation,
      {
        command: (db, c) =>
          driver.db(db).command(c, { signal: topology.signal }),
        close: () => driver.close(true),
      },
      () => {
        topology.signal.throwIfAborted();
        return authorize("command");
      },
    );
    parentPort!.postMessage({ result });
  } catch {
    parentPort!.postMessage({
      result: {
        connection: { status: "UNAVAILABLE", reason: "INVALID" },
        database: unchecked(),
        collections: [],
        cleanup: "COMPLETE",
      },
    });
  } finally {
    try {
      await client?.close(true);
    } catch {
      /* Parent terminates and joins the thread. */
    }
  }
}
