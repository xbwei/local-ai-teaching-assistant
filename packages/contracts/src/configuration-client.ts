import { Ajv } from "ajv";
import type { JSONSchemaType } from "ajv";

// Configuration intent only; never a live capability or authorization decision.
export interface DemoFeatures {
  local: boolean;
  openai: boolean;
  compare: boolean;
  speech: boolean;
}

export const demoFeaturesSchema: JSONSchemaType<DemoFeatures> = {
  type: "object",
  properties: {
    local: { type: "boolean" },
    openai: { type: "boolean" },
    compare: { type: "boolean" },
    speech: { type: "boolean" },
  },
  required: ["local", "openai", "compare", "speech"],
  additionalProperties: false,
  allOf: [
    ...["openai", "compare", "speech"].map((flag) => ({
      if: { properties: { [flag]: { const: true } }, required: [flag] },
      then: { properties: { local: { const: true } } },
    })),
    {
      if: { properties: { compare: { const: true } }, required: ["compare"] },
      then: { properties: { openai: { const: true } } },
    },
  ],
};

export interface ClientConfiguration {
  contractVersion: "client-configuration.v2";
  configurationVersion: "application-configuration.v2";
  features: DemoFeatures;
}

export const clientConfigurationSchema: JSONSchemaType<ClientConfiguration> = {
  $id: "urn:teaching:client-configuration:v2",
  type: "object",
  properties: {
    contractVersion: { type: "string", const: "client-configuration.v2" },
    configurationVersion: {
      type: "string",
      const: "application-configuration.v2",
    },
    features: demoFeaturesSchema,
  },
  required: ["contractVersion", "configurationVersion", "features"],
  additionalProperties: false,
};
const validateClient = new Ajv({ strict: true, ownProperties: true }).compile(
  clientConfigurationSchema,
);

// Keep Ajv diagnostics (which can contain input field names) private.
export function isClientConfiguration(
  value: unknown,
): value is ClientConfiguration {
  return validateClient(value);
}
