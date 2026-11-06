import { initializeOwnerCredential } from "../dist/owner-credential.js";
export const testPassphrase =
  "synthetic owner passphrase for deterministic tests";
export const testCredential = initializeOwnerCredential(testPassphrase);
