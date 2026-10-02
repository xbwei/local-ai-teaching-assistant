import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const keychainMappingContract = "openai-keychain-mapping.v1";
const repositoryRoot = realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
);

export function outsideRepository(file) {
  return (
    file !== repositoryRoot && !file.startsWith(`${repositoryRoot}${path.sep}`)
  );
}

export function credentialShaped(value) {
  return (
    /^sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{12,}$/u.test(value) ||
    /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value) ||
    /^Bearer\s+/iu.test(value)
  );
}

export function validMappingIdentifier(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\0-\x1f\x7f]/u.test(value) &&
    !credentialShaped(value)
  );
}

function validatePrivateDirectory(directory) {
  const info = lstatSync(directory);
  if (
    !path.isAbsolute(directory) ||
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o777) !== 0o700 ||
    realpathSync(directory) !== directory
  )
    throw new Error();
}

export function readKeychainMapping(file) {
  if (
    typeof file !== "string" ||
    !path.isAbsolute(file) ||
    /[\0\r\n]/u.test(file) ||
    !outsideRepository(file)
  )
    throw new Error();
  const info = lstatSync(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.uid !== process.getuid() ||
    (info.mode & 0o777) !== 0o600 ||
    realpathSync(file) !== file
  )
    throw new Error();
  validatePrivateDirectory(path.dirname(file));
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "account,contractVersion,service" ||
    value.contractVersion !== keychainMappingContract ||
    !validMappingIdentifier(value.service) ||
    !validMappingIdentifier(value.account)
  )
    throw new Error();
  return Object.freeze({ service: value.service, account: value.account });
}
