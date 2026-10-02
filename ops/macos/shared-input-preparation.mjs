import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { canonical, privateFile } from "./protected-file.mjs";

export const sttIdentity = "whisper.cpp/1.8.3/small-multilingual/ggml-f16";
export const sttSource = "2eeeba56e9edd762b4b38467bab96c2517163158";
export const sttModelBytes = 487601967;
export const sttModelSha256 =
  "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const hex = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === keys.split(",").sort().join(",");
const reject = () => {
  throw new Error();
};

export function strictJson(bytes) {
  const text = bytes.toString("utf8");
  const value = JSON.parse(text);
  const compact = text.replace(/"(?:\\.|[^"\\])*"|\s+/gu, (part) =>
    part.startsWith('"') ? part : "",
  );
  if (compact !== JSON.stringify(value)) reject();
  return value;
}
export function protectedJson(file) {
  const { bytes } = privateFile(file);
  return { bytes, value: strictJson(bytes) };
}

// The request contains verifier records only. It is never a bearer input.
export function prepareInstructor(configuration, request, now) {
  if (
    !exact(
      request,
      "contractVersion,expectedConfigurationSha256,expectedCredential,provisionedAtEpochSeconds,credential",
    ) ||
    request.contractVersion !== "instructor-preparation.v1" ||
    !hex(request.expectedConfigurationSha256) ||
    !Number.isSafeInteger(now) ||
    request.provisionedAtEpochSeconds !== now
  )
    reject();
  const next = request.credential;
  if (
    !exact(
      next,
      "id,role,courseScopes,tokenSha256,expiresAtEpochSeconds,revoked",
    ) ||
    !/^instructor-operational-[0-9]{3}$/u.test(next.id) ||
    next.role !== "instructor" ||
    JSON.stringify(next.courseScopes) !== '["course-synthetic-demo"]' ||
    !hex(next.tokenSha256) ||
    next.revoked !== false ||
    !Number.isSafeInteger(next.expiresAtEpochSeconds) ||
    next.expiresAtEpochSeconds !== now + 2592000
  )
    reject();
  const records = configuration.access.credentials;
  const targets = records.filter((c) => c.role === "instructor");
  const expected = request.expectedCredential;
  if (expected === null) {
    if (targets.length !== 0) reject();
  } else {
    if (
      targets.length !== 1 ||
      !exact(
        expected,
        "id,role,courseScopes,tokenSha256,expiresAtEpochSeconds,revoked",
      ) ||
      !isDeepStrictEqual(targets[0], expected) ||
      expected.role !== "instructor" ||
      !(expected.revoked === true || expected.expiresAtEpochSeconds <= now) ||
      next.id === expected.id ||
      next.tokenSha256 === expected.tokenSha256
    )
      reject();
  }
  if (
    [...records, ...configuration.access.adminCredentials].some(
      (c) => c.id === next.id || c.tokenSha256 === next.tokenSha256,
    )
  )
    reject();
  const result = structuredClone(configuration);
  result.access.credentials =
    expected === null
      ? [...result.access.credentials, next]
      : result.access.credentials.map((c) => (c.id === expected.id ? next : c));
  return result;
}
export function configurationDigest(bytes) {
  return sha256(bytes);
}

// Preparation may precede installation. Absent asset leaf files are allowed only
// under already protected canonical parents; this never claims bytes verified.
export function protectedAssetPath(file, mode, allowAbsent) {
  if (
    typeof file !== "string" ||
    !path.isAbsolute(file) ||
    path.normalize(file) !== file ||
    /[\0-\x1f\x7f]/u.test(file)
  )
    reject();
  const parent = path.dirname(file);
  if (realpathSync(parent) !== parent) reject();
  for (let dir = parent; ; dir = path.dirname(dir)) {
    const s = lstatSync(dir);
    if (
      !s.isDirectory() ||
      (s.uid !== 0 && s.uid !== process.getuid()) ||
      (s.mode & 0o022) !== 0
    )
      reject();
    try {
      lstatSync(path.join(dir, ".git"));
      reject();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (dir === path.dirname(dir)) break;
  }
  const p = lstatSync(parent);
  if (p.uid !== process.getuid() || (p.mode & 0o7777) !== 0o700) reject();
  let s;
  try {
    s = lstatSync(file);
  } catch (error) {
    if (allowAbsent && error.code === "ENOENT") return;
    throw error;
  }
  canonical(file);
  if (
    !s.isFile() ||
    s.nlink !== 1 ||
    s.uid !== process.getuid() ||
    (s.mode & 0o7777) !== mode
  )
    reject();
}
export function prepareStt(request) {
  if (
    !exact(
      request,
      "contractVersion,sourceCommit,identity,binary,binarySha256,model,modelSha256,modelBytes",
    ) ||
    request.contractVersion !== "stt-preparation.v1" ||
    request.sourceCommit !== sttSource ||
    request.identity !== sttIdentity ||
    !hex(request.binarySha256) ||
    request.modelSha256 !== sttModelSha256 ||
    request.modelBytes !== sttModelBytes ||
    request.binary === request.model
  )
    reject();
  protectedAssetPath(request.binary, 0o700, true);
  protectedAssetPath(request.model, 0o600, true);
  return {
    identity: request.identity,
    binary: request.binary,
    binarySha256: request.binarySha256,
    model: request.model,
  };
}
