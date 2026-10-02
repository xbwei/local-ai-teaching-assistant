import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  linkSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { canonical } from "./protected-file.mjs";
import {
  configurationDigest,
  protectedJson,
  prepareInstructor,
  prepareStt,
  protectedAssetPath,
  sttModelBytes,
} from "./shared-input-preparation.mjs";

import {
  credentialShaped,
  keychainMappingContract,
  outsideRepository,
  readKeychainMapping,
  validMappingIdentifier,
} from "./keychain-mapping.mjs";

const [command, ...args] = process.argv.slice(2);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const validator = path.join(scriptDirectory, "validate-production-config.mjs");

function fail(code) {
  process.stderr.write(`PROVIDER_PREPARATION_ERROR=${code}\n`);
  process.exit(1);
}

function absolute(value) {
  return (
    typeof value === "string" &&
    path.isAbsolute(value) &&
    path.normalize(value) === value &&
    !/[\0-\x1f\x7f]/u.test(value)
  );
}

function existingInfo(file) {
  try {
    return lstatSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function validatePrivateDirectory(directory) {
  if (!absolute(directory)) throw new Error();
  const info = lstatSync(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o7777) !== 0o700 ||
    realpathSync(directory) !== directory
  )
    throw new Error();
}

function validatePrivateFile(file) {
  if (!absolute(file) || !outsideRepository(file)) throw new Error();
  const info = lstatSync(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.uid !== process.getuid() ||
    (info.mode & 0o7777) !== 0o600 ||
    realpathSync(file) !== file
  )
    throw new Error();
  canonical(file);
  validatePrivateDirectory(path.dirname(file));
}

function validateRelease(release) {
  if (!absolute(release)) throw new Error();
  const info = lstatSync(release);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    realpathSync(release) !== release
  )
    throw new Error();
}

function validateDestination(destination) {
  if (!absolute(destination) || !outsideRepository(destination))
    throw new Error();
  validatePrivateDirectory(path.dirname(destination));
  canonical(path.dirname(destination));
  // Also reject a Git root used directly as the destination parent.
  if (existingInfo(path.join(path.dirname(destination), ".git")))
    throw new Error();
  const info = existingInfo(destination);
  if (!info) return;
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.uid !== process.getuid() ||
    (info.mode & 0o7777) !== 0o600 ||
    realpathSync(destination) !== destination
  )
    throw new Error();
}

function syncPath(file) {
  const descriptor = openSync(file, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writePrivateAtomic(
  destination,
  content,
  validatePartial,
  beforeRename,
  createOnly = false,
) {
  validateDestination(destination);
  if (createOnly && existingInfo(destination)) throw new Error();
  const parent = lstatSync(path.dirname(destination));
  let published;
  const partial = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.partial-${randomUUID()}`,
  );
  try {
    writeFileSync(partial, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(partial, 0o600);
    syncPath(partial);
    validatePartial?.(partial);
    if (
      process.env.LAITA_OPERATIONS_TESTING === "1" &&
      process.env.LAITA_TEST_FAIL_PROVIDER_BEFORE_RENAME === "1"
    )
      throw new Error();
    validateDestination(destination);
    beforeRename?.();
    if (createOnly) {
      const currentParent = lstatSync(path.dirname(destination));
      if (parent.dev !== currentParent.dev || parent.ino !== currentParent.ino)
        throw new Error();
      // Atomic no-replace publication: a competing destination always wins.
      // The temporary link is removed before validating single-link identity.
      const identity = lstatSync(partial);
      linkSync(partial, destination);
      published = identity;
      beforeRename?.();
      rmSync(partial);
    } else renameSync(partial, destination);
    syncPath(path.dirname(destination));
    validatePrivateFile(destination);
  } catch {
    if (published) {
      const current = existingInfo(destination);
      if (current?.dev === published.dev && current?.ino === published.ino)
        rmSync(destination);
    }
    rmSync(partial, { force: true });
    throw new Error();
  }
}

function validOpaqueReference(value) {
  return (
    typeof value === "string" &&
    /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(value) &&
    !credentialShaped(value)
  );
}

function validateWithExistingValidator(
  release,
  configurationFile,
  runtimeRoot,
  port,
  expected,
) {
  const result = spawnSync(
    process.execPath,
    [validator, release, configurationFile, runtimeRoot, port],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10000,
      maxBuffer: 4096,
    },
  );
  if (
    result.status !== 0 ||
    result.signal !== null ||
    result.stderr !== "" ||
    result.stdout.trim() !== expected
  )
    throw new Error();
}

function prepareConfiguration() {
  const [release, source, destination, runtimeRoot, port] = args;
  if (
    args.length !== 5 ||
    !absolute(runtimeRoot) ||
    !/^[0-9]{4,5}$/u.test(port ?? "")
  )
    throw new Error();
  validateRelease(release);
  validatePrivateFile(source);
  validateDestination(destination);
  if (source === destination || realpathSync(source) === destination)
    throw new Error();
  const referenceId = process.env.LAITA_OPENAI_SECRET_REFERENCE_ID;
  if (!validOpaqueReference(referenceId)) throw new Error();
  validateWithExistingValidator(
    release,
    source,
    runtimeRoot,
    port,
    "LOCAL_ONLY",
  );
  const sourceText = readFileSync(source, "utf8");
  const configuration = JSON.parse(sourceText);
  configuration.providers.openai.secretReference = {
    kind: "opaque",
    id: referenceId,
  };
  configuration.features = {
    local: true,
    openai: true,
    compare: true,
    speech: false,
  };
  const candidate = `${JSON.stringify(configuration, null, 2)}\n`;
  writePrivateAtomic(destination, candidate, (partial) =>
    validateWithExistingValidator(
      release,
      partial,
      runtimeRoot,
      port,
      "PROVIDER_ENABLED",
    ),
  );
  if (readFileSync(source, "utf8") !== sourceText) throw new Error();
  process.stdout.write("PROVIDER_CONFIG_PREPARED\n");
}

function prepareMapping() {
  const [destination] = args;
  if (args.length !== 1) throw new Error();
  const service = process.env.LAITA_OPENAI_KEYCHAIN_SERVICE;
  const account = process.env.LAITA_OPENAI_KEYCHAIN_ACCOUNT;
  if (!validMappingIdentifier(service) || !validMappingIdentifier(account))
    throw new Error();
  writePrivateAtomic(
    destination,
    `${JSON.stringify({
      contractVersion: keychainMappingContract,
      service,
      account,
    })}\n`,
    readKeychainMapping,
  );
  readKeychainMapping(destination);
  process.stdout.write("KEYCHAIN_MAPPING_PREPARED\n");
}

function verifyMapping() {
  const [file] = args;
  if (args.length !== 1) throw new Error();
  readKeychainMapping(file);
  process.stdout.write("KEYCHAIN_MAPPING_VALID\n");
}

function sourceConfiguration(expectedVersion, successor = false) {
  const [release, source, destination, runtimeRoot, port] = args;
  if (!absolute(runtimeRoot) || !/^[0-9]{4,5}$/u.test(port ?? ""))
    throw new Error();
  validateRelease(release);
  validatePrivateFile(source);
  validateDestination(destination);
  if (source === destination) throw new Error();
  const { bytes, value } = protectedJson(source);
  if (!successor)
    validateWithExistingValidator(
      release,
      source,
      runtimeRoot,
      port,
      "PROVIDER_ENABLED",
    );
  if (
    value.provenance.demoProfileVersion !==
      `demo-profile.v${expectedVersion}` ||
    value.provenance.policyVersion !== `demo-policy.v${expectedVersion}` ||
    value.features.speech !== expectedVersion >= 3 ||
    value.access.enabled !== true ||
    value.access.mode !== "single-operator"
  )
    throw new Error();
  return { release, source, destination, runtimeRoot, port, bytes, value };
}
function publishConfiguration(f, value, guard = () => {}) {
  writePrivateAtomic(
    f.destination,
    `${JSON.stringify(value, null, 2)}\n`,
    (partial) =>
      validateWithExistingValidator(
        f.release,
        partial,
        f.runtimeRoot,
        f.port,
        "PROVIDER_ENABLED",
      ),
    () => {
      if (!protectedJson(f.source).bytes.equals(f.bytes)) throw new Error();
      guard();
    },
  );
}
function prepareV4() {
  if (args.length !== 5) throw new Error();
  const f = sourceConfiguration(2);
  const candidate = structuredClone(f.value);
  candidate.provenance = {
    demoProfileVersion: "demo-profile.v4",
    policyVersion: "demo-policy.v4",
  };
  candidate.features.speech = true;
  publishConfiguration(f, candidate);
  process.stdout.write("SHARED_INPUT_CONFIG_PREPARED\n");
}
function prepareOwner() {
  if (args.length !== 5) throw new Error();
  // The successor validator rejects retired settings. Validate the entire
  // resulting candidate atomically, preserving the original protected file.
  const f = sourceConfiguration(3, true);
  const old = f.value.access.browserSessions;
  if (
    old !== undefined &&
    old !== null &&
    (!isDeepStrictEqual(Object.keys(old).sort(), [
      "pairingTtlSeconds",
      "sessionTtlSeconds",
    ]) ||
      !Number.isSafeInteger(old.pairingTtlSeconds) ||
      old.pairingTtlSeconds < 30 ||
      old.pairingTtlSeconds > 600 ||
      !Number.isSafeInteger(old.sessionTtlSeconds) ||
      old.sessionTtlSeconds < 60 ||
      old.sessionTtlSeconds > 28800)
  )
    throw new Error();
  for (const field of ["courseGrounding", "kiosk", "ownerDemoWeb"])
    if (typeof f.value.features[field] !== "boolean") throw new Error();
  if (f.value.features.courseGrounding || f.value.features.kiosk)
    throw new Error();
  const candidate = structuredClone(f.value);
  delete candidate.access.browserSessions;
  delete candidate.features.courseGrounding;
  delete candidate.features.kiosk;
  delete candidate.features.ownerDemoWeb;
  candidate.provenance = {
    demoProfileVersion: "demo-profile.v4",
    policyVersion: "demo-policy.v4",
  };
  publishConfiguration(f, candidate);
  process.stdout.write("OWNER_CONFIG_PREPARED\n");
}
function prepareCredential() {
  if (args.length !== 6) throw new Error();
  const f = sourceConfiguration(4);
  const requestFile = args[5];
  if (requestFile === f.destination || requestFile === f.source)
    throw new Error();
  const request = protectedJson(requestFile);
  if (
    request.value.expectedConfigurationSha256 !== configurationDigest(f.bytes)
  )
    throw new Error();
  // The timestamp is the actual issuance time supplied through the protected
  // boundary, never a synthetic expiry or automatic renewal at helper runtime.
  const now = Math.floor(Date.now() / 1000);
  const issued = request.value.provisionedAtEpochSeconds;
  // Preparation can follow issuance, but never backdate/extend the 30-day life.
  if (!Number.isSafeInteger(issued) || issued > now || issued + 2592000 <= now)
    throw new Error();
  const candidate = prepareInstructor(f.value, request.value, issued);
  publishConfiguration(f, candidate, () => {
    if (
      !protectedJson(requestFile).bytes.equals(request.bytes) ||
      candidate.access.credentials.some(
        (c) =>
          c.id === request.value.credential.id &&
          c.expiresAtEpochSeconds <= Math.floor(Date.now() / 1000),
      )
    )
      throw new Error();
  });
  process.stdout.write("INSTRUCTOR_VERIFIER_PREPARED\n");
}
function prepareSttProfile() {
  if (args.length !== 2) throw new Error();
  const [requestFile, destination] = args;
  if (
    requestFile === destination ||
    path.basename(destination) !== "stt-profile.json"
  )
    throw new Error();
  const request = protectedJson(requestFile);
  const profile = prepareStt(request.value);
  if ([profile.binary, profile.model].includes(destination)) throw new Error();
  writePrivateAtomic(
    destination,
    `${JSON.stringify(profile)}\n`,
    (partial) => protectedJson(partial),
    () => {
      if (!protectedJson(requestFile).bytes.equals(request.bytes))
        throw new Error();
      prepareStt(request.value);
    },
  );
  process.stdout.write("STT_PROFILE_PREPARED_ASSETS_NOT_VERIFIED\n");
}
async function verifySttProfile() {
  if (args.length !== 2) throw new Error();
  const [release, file] = args;
  validateRelease(release);
  if (path.basename(file) !== "stt-profile.json") throw new Error();
  const snapshot = protectedJson(file);
  protectedAssetPath(snapshot.value.binary, 0o700, false);
  protectedAssetPath(snapshot.value.model, 0o600, false);
  if (lstatSync(snapshot.value.model).size !== sttModelBytes) throw new Error();
  const { loadWhisperAdapter } = await import(
    pathToFileURL(path.join(release, "packages/speech-client/dist/whisper.js"))
  );
  const assets = [snapshot.value.binary, snapshot.value.model];
  const before = assets.map((asset) => lstatSync(asset));
  // Loads and hashes only. Never call transcribe or spawn a native process.
  loadWhisperAdapter(file);
  assets.forEach((asset, index) => {
    protectedAssetPath(asset, index === 0 ? 0o700 : 0o600, false);
    const after = lstatSync(asset);
    if (
      ["dev", "ino", "size", "mtimeMs", "ctimeMs", "mode", "uid", "nlink"].some(
        (key) => before[index][key] !== after[key],
      )
    )
      throw new Error();
  });
  if (!protectedJson(file).bytes.equals(snapshot.bytes)) throw new Error();
  process.stdout.write("STT_PROFILE_ASSETS_VERIFIED\n");
}

try {
  if (command === "config") prepareConfiguration();
  else if (command === "shared-input-config") prepareV4();
  else if (command === "owner-config") prepareOwner();
  else if (command === "instructor-verifier") prepareCredential();
  else if (command === "stt-profile") prepareSttProfile();
  else if (command === "verify-stt-profile") await verifySttProfile();
  else if (command === "mapping") prepareMapping();
  else if (command === "verify-mapping") verifyMapping();
  else fail("INVALID_COMMAND");
} catch {
  if (
    [
      "shared-input-config",
      "owner-config",
      "instructor-verifier",
      "stt-profile",
      "verify-stt-profile",
    ].includes(command)
  )
    fail("SHARED_INPUT_PREPARATION_FAILED");
  fail(
    command === "config"
      ? "CONFIG_PREPARATION_FAILED"
      : command === "mapping"
        ? "MAPPING_PREPARATION_FAILED"
        : "MAPPING_VALIDATION_FAILED",
  );
}
