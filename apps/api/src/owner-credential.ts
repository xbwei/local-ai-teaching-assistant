import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { OwnerCredential } from "@laita/persistence";

// Fixed, versioned by the migration/implementation: scrypt N=131072, r=8, p=1.
function derive(passphrase: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      passphrase,
      Buffer.from(salt, "hex"),
      32,
      { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}
export async function initializeOwnerCredential(
  passphrase: string,
): Promise<OwnerCredential> {
  if (passphrase.length < 15 || Buffer.byteLength(passphrase, "utf8") > 1024)
    throw new Error(
      "Use a passphrase of at least 15 characters (at most 1024 UTF-8 bytes).",
    );
  const salt = randomBytes(16).toString("hex");
  const key = await derive(passphrase, salt);
  try {
    return {
      salt,
      verifier: key.toString("hex"),
      revision: randomBytes(16).toString("hex"),
    };
  } finally {
    key.fill(0);
  }
}
export async function verifyOwnerCredential(
  passphrase: string,
  credential: OwnerCredential,
): Promise<boolean> {
  if (Buffer.byteLength(passphrase, "utf8") > 1024) return false;
  const key = await derive(passphrase, credential.salt);
  try {
    return timingSafeEqual(key, Buffer.from(credential.verifier, "hex"));
  } finally {
    key.fill(0);
  }
}
