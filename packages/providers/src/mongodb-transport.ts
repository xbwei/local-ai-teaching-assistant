import { MongoClient, type MongoClientOptions } from "mongodb";
import dns from "node:dns";
import {
  mongoHost,
  validMongoCredential,
  validMongoExpectation,
  type MongoWorkerInput,
} from "./mongodb-verification.ts";
import { Connection } from "mongodb/lib/cmap/connection.js";
import type { Duplex } from "node:stream";

/** Inspect framing before the pinned driver's BSON buffering. The budget covers
 * every socket (including authentication and monitoring) for this one worker.
 * Compression is not negotiated and compressed frames are rejected. */
export function mongoWireBudget() {
  let bytes = 0;
  return (stream: Duplex) => {
    const emit = stream.emit;
    const header = Buffer.alloc(16);
    let headerBytes = 0,
      remaining = 0;
    stream.emit = function (event: string | symbol, ...args: unknown[]) {
      if (event !== "data") return emit.call(this, event, ...args);
      const chunk = args[0];
      const stop = () => {
        const error = Object.assign(new Error("MONGO_WIRE_LIMIT"), {
          code: "LIMIT",
        });
        this.destroy(error);
        return false;
      };
      if (!Buffer.isBuffer(chunk) || (bytes += chunk.length) > 1024 * 1024)
        return stop();
      let at = 0;
      let delivered = false;
      while (at < chunk.length) {
        if (remaining) {
          const take = Math.min(remaining, chunk.length - at);
          delivered =
            emit.call(this, event, chunk.subarray(at, at + take)) || delivered;
          remaining -= take;
          at += take;
          continue;
        }
        const take = Math.min(16 - headerBytes, chunk.length - at);
        chunk.copy(header, headerBytes, at, at + take);
        headerBytes += take;
        at += take;
        if (headerBytes === 16) {
          const length = header.readInt32LE(0),
            opcode = header.readInt32LE(12);
          if (length < 16 || length > 128 * 1024 || ![1, 2013].includes(opcode))
            return stop();
          // Never pass a partial/unvalidated header to the decoder: even a
          // four-byte zero length can otherwise stall its framing loop.
          delivered = emit.call(this, event, Buffer.from(header)) || delivered;
          remaining = length - 16;
          headerBytes = 0;
        }
      }
      return delivered;
    };
  };
}
export function boundedMongoConnection() {
  const attach = mongoWireBudget();
  return class BoundedConnection extends Connection {
    constructor(stream: Duplex, options: object) {
      attach(stream);
      super(stream, options);
    }
  };
}

// Only this exact object can interrupt an asynchronous SDAM callback. The
// dedicated worker handles it while closing the client and awaiting cleanup.
export const mongoTopologyDenied = Object.assign(Error("INVALID"), {
  code: "INVALID",
});

/** Normal driver SRV selection, bounded to this request's approved seed members. */
export function createMongoClient(
  input: MongoWorkerInput,
  authorizeSource: () => Promise<void>,
  topology = new AbortController(),
): MongoClient {
  const invalid = () => Object.assign(Error("INVALID"), { code: "INVALID" });
  if (
    !validMongoCredential(input.credential) ||
    !validMongoExpectation(input.expectation)
  )
    throw invalid();

  const seed = input.expectation.host;
  const suffix = seed.slice(seed.indexOf("."));
  const members = new Set<string>();
  // A system getaddrinfo already running on libuv's pool can delay Worker
  // termination. A cancellable DNS A query keeps this socket check bounded.
  const resolver = new dns.promises.Resolver({ timeout: 2000, tries: 1 });
  let records = 0;
  let discovered = false;
  let pendingAuthority: Promise<void> | undefined;
  const credential = JSON.parse(input.credential) as {
    username: string;
    password: string;
  };
  const options = {
    // Pass decoded credentials as separate options. Only the protected seed
    // enters the new URI; neither the submission text nor its options do.
    auth: credential,
    authSource: "admin",
    tls: true,
    rejectUnauthorized: true,
    tlsAllowInvalidCertificates: false,
    tlsAllowInvalidHostnames: false,
    srvHostValidator(host) {
      if (
        discovered ||
        ++records > 3 ||
        !mongoHost(host) ||
        !host.endsWith(suffix)
      )
        return false;
      members.add(host);
      return true;
    },
    family: 4,
    autoSelectFamily: false,
    lookup(host, options, done) {
      // Filter the actual socket lookup result. There is no later DNS lookup
      // and no address pinning across driver connections.
      const resolve = async () => {
        topology.signal.throwIfAborted();
        if (!members.has(host)) throw invalid();
        const addresses = await resolver.resolve4(host + ".");
        if (
          !addresses.length ||
          addresses.length > 8 ||
          !addresses.every(mongoPublicIPv4)
        )
          throw invalid();
        topology.signal.throwIfAborted();
        // Rebind the current source after DNS and before TCP or authentication.
        // Several monitors resolving together can share this in-flight check.
        pendingAuthority ??= authorizeSource().finally(() => {
          pendingAuthority = undefined;
        });
        await pendingAuthority;
        topology.signal.throwIfAborted();
        return addresses;
      };
      void resolve().then(
        (addresses) => {
          if (options.all)
            done(
              null,
              addresses.map((address) => ({ address, family: 4 })),
            );
          else done(null, addresses[0]!, 4);
        },
        () => done(invalid(), "", 4),
      );
    },
    retryReads: false,
    retryWrites: false,
    maxPoolSize: 1,
    minPoolSize: 0,
    maxConnecting: 1,
    connectTimeoutMS: 2500,
    serverSelectionTimeoutMS: 3000,
    socketTimeoutMS: 4000,
    waitQueueTimeoutMS: 3000,
    heartbeatFrequencyMS: 60_000,
    serverMonitoringMode: "poll",
    readPreference: "primaryPreferred",
    monitorCommands: false,
    mongodbLogComponentSeverities: { default: "off" },
    compressors: [],
  } satisfies MongoClientOptions;
  const client = new MongoClient(`mongodb+srv://${seed}`, {
    ...options,
    connectionType: boundedMongoConnection(),
  } as MongoClientOptions);

  const rejectTopology = (): never => {
    // Abort selection/operations immediately. Throwing also stops the driver
    // callback before SDAM can open a socket or accept the unsafe heartbeat.
    topology.abort(mongoTopologyDenied);
    throw mongoTopologyDenied;
  };
  const allowedAddress = (address: string) =>
    address.endsWith(":27017") && members.has(address.slice(0, -6));
  client.once("topologyOpening", () => {
    discovered = true;
    // In 7.9.0 a TXT loadBalanced=true can override explicit URI false.
    // Validate after SRV/TXT resolution and before the driver starts monitors.
    if (
      client.options.loadBalanced ||
      !client.options.hosts.length ||
      !client.options.hosts.every((host) => allowedAddress(host.toString()))
    )
      rejectTopology();
  });
  client.once("topologyClosed", () => resolver.cancel());
  client.on("serverOpening", ({ address }) => {
    // SDAM also learns addresses from hello. This event precedes all socket
    // creation, including for newly advertised IP literals or Unix paths.
    if (!allowedAddress(address)) rejectTopology();
  });
  client.on("serverHeartbeatSucceeded", ({ reply }) => {
    // Before server selection, accept replica-set members only.
    if (
      !reply ||
      typeof reply !== "object" ||
      typeof reply.setName !== "string" ||
      !reply.setName ||
      reply.msg === "isdbgrid"
    )
      rejectTopology();
  });
  return client;
}

/** IPv4-only socket policy. Reject private and other special-use addresses. */
export function mongoPublicIPv4(value: string) {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(value)) return false;
  const a = value.split(".").map(Number);
  if (a.some((n, i) => n > 255 || String(n) !== value.split(".")[i]))
    return false;
  const [x, y, z] = a;
  return (
    x! > 0 &&
    x! < 224 &&
    ![10, 127].includes(x!) &&
    !(x === 100 && y! >= 64 && y! <= 127) &&
    !(x === 169 && y === 254) &&
    !(x === 172 && y! >= 16 && y! <= 31) &&
    !(
      x === 192 &&
      (y === 168 || (y === 0 && (z === 0 || z === 2)) || (y === 88 && z === 99))
    ) &&
    !(x === 198 && (y === 18 || y === 19 || (y === 51 && z === 100))) &&
    !(x === 203 && y === 0 && z === 113)
  );
}
