import type { CapabilityAvailability } from "./capability.ts";
import { isProviderRunRequest } from "./provider-control.ts";
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
const text = (v: unknown) =>
  typeof v === "string" && v.length > 0 && Array.from(v).length <= 128;
const recheck = [
  "INPUT_CHANGE",
  "ARTIFACT_CHANGE",
  "COURSE_OR_MODULE_CHANGE",
  "WORKFLOW_OR_MODE_CHANGE",
  "PROVIDER_OR_MODEL_CHANGE",
  "SCHEDULE_OR_FEATURE_CHANGE",
  "BUDGET_OR_QUOTA_CHANGE",
  "ASSESSMENT_STATE_CHANGE",
  "POLICY_VERSION_CHANGE",
  "PROVIDER_HEALTH_CHANGE",
];
/** CSP-safe reader for the reviewed capability wire shape; no code generation.
 * Reject ambiguous duplicate provider/mode IDs even if their other fields differ.
 */
export function isBrowserCapability(v: unknown): v is CapabilityAvailability {
  if (
    !record(v) ||
    !exact(v, [
      "contractVersion",
      "decisionRef",
      "identity",
      "providers",
      "modes",
      "guidance",
      "recheckOn",
    ]) ||
    v.contractVersion !== "capability-availability.v1" ||
    typeof v.decisionRef !== "string" ||
    !/^decision-[a-f0-9]{24}$/u.test(v.decisionRef)
  )
    return false;
  if (
    !isProviderRunRequest({
      contractVersion: "provider-run-request.v1",
      clientRequestId: "00000000-0000-4000-8000-000000000000",
      mode: "LOCAL",
      localModel: "shape-validation",
      input: { text: "shape-validation" },
      capabilityIdentity: v.identity,
    })
  )
    return false;
  if (
    !Array.isArray(v.recheckOn) ||
    v.recheckOn.length !== recheck.length ||
    !v.recheckOn.every((k, i) => k === recheck[i]) ||
    ![
      "SELECT_AVAILABLE_MODE",
      "LOCAL_PROGRESS",
      "NO_PROVIDER_AVAILABLE",
    ].includes(v.guidance as string)
  )
    return false;
  if (
    !Array.isArray(v.providers) ||
    v.providers.length > 2 ||
    !Array.isArray(v.modes) ||
    v.modes.length > 3
  )
    return false;
  const providers = new Set<string>();
  for (const p of v.providers) {
    if (
      !record(p) ||
      !exact(p, ["id", "label", "state", "models"]) ||
      !(
        (p.id === "LOCAL" &&
          p.label === "Local" &&
          ["READY", "LOADING", "SWITCHING", "BUSY", "UNAVAILABLE"].includes(
            p.state as string,
          )) ||
        (p.id === "OPENAI" && p.label === "OpenAI" && p.state === "READY")
      ) ||
      !Array.isArray(p.models) ||
      p.models.length < 1 ||
      p.models.length > 8 ||
      providers.has(p.id as string)
    )
      return false;
    providers.add(p.id as string);
    const models = new Set<string>();
    for (const m of p.models) {
      if (
        !record(m) ||
        !exact(m, ["id", "label"]) ||
        !text(m.id) ||
        !text(m.label) ||
        models.has(m.id as string)
      )
        return false;
      models.add(m.id as string);
    }
  }
  const modes = new Set<string>();
  for (const m of v.modes) {
    if (
      !record(m) ||
      !exact(m, ["id", "label", "providers"]) ||
      !Array.isArray(m.providers) ||
      modes.has(m.id as string)
    )
      return false;
    const expected =
      m.id === "LOCAL"
        ? ["LOCAL"]
        : m.id === "OPENAI"
          ? ["OPENAI"]
          : m.id === "COMPARE"
            ? ["LOCAL", "OPENAI"]
            : undefined;
    const label =
      m.id === "LOCAL" ? "Local" : m.id === "OPENAI" ? "OpenAI" : "Compare";
    if (
      !expected ||
      m.label !== label ||
      m.providers.length !== expected.length ||
      !m.providers.every((p, i) => p === expected[i] && providers.has(p))
    )
      return false;
    modes.add(m.id as string);
  }
  return true;
}
