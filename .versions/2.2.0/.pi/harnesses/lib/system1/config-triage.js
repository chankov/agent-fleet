// Pure configuration validation shared by Node CLI and Hub.
// @ts-nocheck
export const TRIAGE_VERSION = "dispatch-triage/v1";
export const TASK_TRIAGE_QUESTION_VERSION = "task-triage/questions/v1";
export const TASK_TRIAGE_POLICY_VERSION = "task-triage/policy/v1";
export const TASK_TRIAGE_STATE_VERSION = "task-triage/state/v1";
export const TASK_TRIAGE_PROVIDER = "typesafe";
export const TASK_TRIAGE_MODEL = "jev-1.13.0";
export const TASK_TRIAGE_LIMITS = Object.freeze({ maxTaskBytes: 40 * 1024, maxStateBytes: 64 * 1024, maxCallsPerSession: 100, timeoutMs: 2000 });
export function validProfile(p) {
    const x = p;
    return !!x && x.version === TRIAGE_VERSION && x.approved === true && typeof x.evidence === "string" && !!x.evidence.trim()
        && typeof x.provider === "string" && !!x.provider && typeof x.model === "string" && !!x.model
        && [x.languages, x.domains].every(v => Array.isArray(v) && v.length > 0 && v.every(s => typeof s === "string" && !!s))
        && [x.minConfidence, x.minMargin, x.securityThreshold, x.destructiveThreshold].every(v => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1);
}
export function parseTriageConfig(value) {
    const c = value;
    if (!c || typeof c !== "object" || Array.isArray(c) || Object.keys(c).some(k => !["version", "mode", "remoteContextApproved", "maxCalls", "maxStateBytes", "maxTaskBytes", "maxRoleBytes", "profile", "orchestratorBeforeDispatch"].includes(k)) || c.version !== 1 || !["off", "shadow", "advisory"].includes(c.mode) || typeof c.remoteContextApproved !== "boolean")
        return null;
    if (![c.maxCalls, c.maxStateBytes, c.maxTaskBytes, c.maxRoleBytes].every(n => Number.isSafeInteger(n) && n > 0))
        return null;
    if (c.profile !== undefined && !validProfile(c.profile))
        return null;
    if (c.orchestratorBeforeDispatch !== undefined && typeof c.orchestratorBeforeDispatch !== "boolean")
        return null;
    return JSON.parse(JSON.stringify(c));
}
const keys = ["version", "mode", "remoteContextApproved", "provider", "model", "questionVersion", "policyVersion", "limits"];
export function parseTaskTriageConfig(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return { status: "invalid" };
    const x = value;
    if (Object.keys(x).some(k => !keys.includes(k)) || x.version !== 1 || (x.mode !== "off" && x.mode !== "experimental") || typeof x.remoteContextApproved !== "boolean" || x.provider !== TASK_TRIAGE_PROVIDER || x.model !== TASK_TRIAGE_MODEL || x.questionVersion !== TASK_TRIAGE_QUESTION_VERSION || x.policyVersion !== TASK_TRIAGE_POLICY_VERSION || !x.limits || typeof x.limits !== "object" || Array.isArray(x.limits))
        return { status: "invalid" };
    const limits = x.limits;
    if (Object.keys(limits).length !== Object.keys(TASK_TRIAGE_LIMITS).length || Object.entries(TASK_TRIAGE_LIMITS).some(([k, v]) => limits[k] !== v))
        return { status: "invalid" };
    if (x.mode === "off")
        return x.remoteContextApproved ? { status: "invalid" } : { status: "off" };
    return x.remoteContextApproved ? { status: "active", config: x } : { status: "off" };
}
