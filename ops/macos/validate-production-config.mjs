import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [release, configurationFile, runtimeRoot, portText] =
  process.argv.slice(2);
if (
  !release ||
  !configurationFile ||
  !path.isAbsolute(release) ||
  !path.isAbsolute(configurationFile) ||
  !path.isAbsolute(runtimeRoot ?? "") ||
  !/^[0-9]{4,5}$/u.test(portText ?? "")
)
  process.exit(1);

let parseConfiguration;
try {
  ({ parseConfiguration } = await import(
    pathToFileURL(
      path.join(release, "node_modules/@laita/runtime/dist/index.js"),
    )
  ));
} catch {
  process.exit(1);
}

let parsed;
try {
  parsed = parseConfiguration(readFileSync(configurationFile, "utf8"));
} catch {
  process.exit(1);
}
const configuration = parsed.ok ? parsed.value : null;
const fixed =
  configuration &&
  configuration.contractVersion === "application-configuration.v2" &&
  ((configuration.provenance.demoProfileVersion === "demo-profile.v2" &&
    configuration.provenance.policyVersion === "demo-policy.v2" &&
    configuration.features.speech === false) ||
    (configuration.provenance.demoProfileVersion === "demo-profile.v4" &&
      configuration.provenance.policyVersion === "demo-policy.v4")) &&
  configuration.mode === "operator" &&
  configuration.server.bind === "loopback" &&
  configuration.server.port === Number(portText) &&
  configuration.runtimeRoot === runtimeRoot &&
  configuration.features.local === true &&
  configuration.providers.local.provider === "LOCAL" &&
  ["gemma4:12b-mlx", "llama3.1:8b"].includes(
    configuration.providers.local.model,
  ) &&
  JSON.stringify(configuration.providers.local.candidates) ===
    JSON.stringify(["gemma4:12b-mlx", "llama3.1:8b"]) &&
  configuration.providers.openai.provider === "OPENAI" &&
  configuration.providers.openai.model === "gpt-5.6-luna";
const reference = configuration?.providers.openai.secretReference;
const localOnly =
  fixed &&
  configuration.features.openai === false &&
  configuration.features.compare === false &&
  reference === null;
const providerConfig =
  fixed &&
  configuration.features.openai === true &&
  configuration.features.compare === true &&
  reference?.kind === "opaque" &&
  typeof reference.id === "string";

if (localOnly) process.stdout.write("LOCAL_ONLY\n");
else if (providerConfig) process.stdout.write("PROVIDER_ENABLED\n");
else process.exit(1);
