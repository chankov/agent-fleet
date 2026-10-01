// Desired state stores direct feature choices. Runtime selection also includes
// the manifest dependency system1-task-triage -> system1 without rewriting the
// human-owned desired file. Task-context consent remains a separate runtime gate.
/** @param {unknown} desired */
export function system1SelectedByDesired(desired) {
  if (!desired || typeof desired !== "object" || Array.isArray(desired)) return false;
  const features = /** @type {{ features?: unknown }} */ (desired).features;
  if (!features || typeof features !== "object" || Array.isArray(features)) return false;
  const selection = /** @type {{ system1?: unknown, "system1-task-triage"?: unknown }} */ (features);
  return selection.system1 === true || selection["system1-task-triage"] === true;
}
