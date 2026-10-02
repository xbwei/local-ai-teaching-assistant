import { readFileSync, writeFileSync } from "node:fs";

import { readKeychainMapping } from "./keychain-mapping.mjs";

const [templatePath, outputPath] = process.argv.slice(2);
if (!templatePath || !outputPath) process.exit(2);

const required = [
  "LAITA_SERVICE_LABEL",
  "LAITA_DEPLOY_ROOT",
  "LAITA_NODE_BIN",
  "LAITA_NODE_PATH",
];
for (const name of required) {
  const value = process.env[name];
  if (
    !value ||
    value.length > 4096 ||
    /[\0-\x1f\x7f]/u.test(value) ||
    (name !== "LAITA_SERVICE_LABEL" && !value.startsWith("/"))
  ) {
    process.exit(2);
  }
}
if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/u.test(process.env.LAITA_SERVICE_LABEL))
  process.exit(2);

const xml = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const replacements = {
  __SERVICE_LABEL__: process.env.LAITA_SERVICE_LABEL,
  __DEPLOY_ROOT__: process.env.LAITA_DEPLOY_ROOT,
  __NODE_BIN__: process.env.LAITA_NODE_BIN,
  __CONTROLLED_PATH__: process.env.LAITA_NODE_PATH,
};
let result = readFileSync(templatePath, "utf8");
for (const [marker, value] of Object.entries(replacements))
  result = result.replaceAll(marker, xml(value));
if (![undefined, "0", "1"].includes(process.env.LAITA_OPENAI_KEYCHAIN_ENABLED))
  process.exit(2);
const keychainEnabled = process.env.LAITA_OPENAI_KEYCHAIN_ENABLED === "1";
const mappingFile = process.env.LAITA_OPENAI_KEYCHAIN_MAPPING_FILE;
let keychainMapping;
try {
  if (keychainEnabled) keychainMapping = readKeychainMapping(mappingFile);
  else if (mappingFile !== undefined && mappingFile !== "") process.exit(2);
} catch {
  process.exit(2);
}
const keychainEnvironment = keychainEnabled
  ? [
      "    <key>LAITA_OPENAI_KEYCHAIN_SERVICE</key>",
      `    <string>${xml(keychainMapping.service)}</string>`,
      "    <key>LAITA_OPENAI_KEYCHAIN_ACCOUNT</key>",
      `    <string>${xml(keychainMapping.account)}</string>`,
    ].join("\n")
  : "";
result = result.replaceAll(
  "__OPENAI_KEYCHAIN_ENVIRONMENT__",
  keychainEnvironment,
);
if (/__[A-Z_]+__/u.test(result)) process.exit(2);
writeFileSync(outputPath, result, { encoding: "utf8", mode: 0o600 });
