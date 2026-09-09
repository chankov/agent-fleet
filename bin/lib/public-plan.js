// Explicit public serialization boundary: write buffers never cross stdout/stderr.
const SECRET_BEARING_KEYS = new Set(["text", "original", "replacement", "before", "after", "backup"]);
export const PUBLIC_PLAN_SCHEMA_VERSION = 1;
function safe(value, key = "") {
  if (SECRET_BEARING_KEYS.has(key)) return undefined;
  if (Array.isArray(value)) return value.map((item) => safe(item)).filter((item) => item !== undefined);
  if (!value || typeof value !== "object") return value;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return undefined;
  return Object.fromEntries(Object.entries(value).flatMap(([name, item]) => {
    const cleaned = safe(item, name); return cleaned === undefined ? [] : [[name, cleaned]];
  }));
}
export function publicPlan(plan, stage = "preview") { return { ...safe(plan), publicSchemaVersion: PUBLIC_PLAN_SCHEMA_VERSION, stage }; }
export function publicResult(result, stage = "apply") { return { ...safe(result), publicSchemaVersion: PUBLIC_PLAN_SCHEMA_VERSION, stage }; }
export function publicRepairPreview(proposal) {
  return { publicSchemaVersion: PUBLIC_PLAN_SCHEMA_VERSION, stage: "config-repair-preview", configRepair: { path: proposal.path, removed: proposal.removed, requiresApproval: true, nextStep: "Run setup interactively, or setup --yes --repair-config. No mutation was applied." } };
}
