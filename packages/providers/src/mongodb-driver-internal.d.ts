/** Deliberately narrow bridge to the pinned mongodb 7.9.0 connection constructor.
 * The driver does not expose a public pre-BSON byte-limit hook. Upgrade only with
 * the transport and real driver option-admission tests; no global driver patch. */
declare module "mongodb/lib/cmap/connection.js" {
  import type { Document } from "mongodb";
  import type { Duplex } from "node:stream";
  export class Connection {
    constructor(stream: Duplex, options: object);
    command(
      namespace: object,
      command: Document,
      options?: object,
      responseType?: unknown,
    ): Promise<Document>;
  }
}
