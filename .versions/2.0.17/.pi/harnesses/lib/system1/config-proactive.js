// Pure configuration validation shared by Node CLI and Hub.
// @ts-nocheck
const safePath = (path) => typeof path === "string" && path.length > 0 && path.length <= 256 && !path.includes("\\") && !path.includes("\0") && !path.startsWith("/") && path.split("/").every(s => !!s && s !== "." && s !== ".." && !s.startsWith("."));
const safeRulePath = (path) => typeof path === "string" && path.startsWith(".ai/") ? safePath(path.slice(4)) : safePath(path);
const exact = (v, keys) => typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).every(k => keys.includes(k)) && keys.every(k => k in v);
const paths = (v) => Array.isArray(v) && v.length <= 32 && v.every(safePath) && new Set(v).size === v.length;
const safeBasename = (v) => typeof v === "string" && safePath(v) && !v.includes("/") && !v.includes("*") && !v.includes("?");
export function parseLocalBindings(value) {
    if (!Array.isArray(value) || value.length > 16)
        throw new Error("Invalid local bindings");
    return Object.freeze(value.map((item) => {
        if (!exact(item, ["version", "validator", "rule", "applicability", "exceptions", "placement"]) && !exact(item, ["version", "validator", "rule", "applicability", "exceptions"]))
            throw new Error("Invalid local binding schema");
        const b = item;
        if (b.version !== 1 || !["relative-markdown-links", "new-file-placement"].includes(b.validator) ||
            !exact(b.rule, ["path", "heading", "occurrence", "hash"]) || !safeRulePath(b.rule.path) || !b.rule.path.endsWith(".md") ||
            typeof b.rule.heading !== "string" || !b.rule.heading.trim() || b.rule.heading.length > 200 || !Number.isSafeInteger(b.rule.occurrence) || b.rule.occurrence < 1 || !/^[a-f0-9]{64}$/.test(b.rule.hash) ||
            (!exact(b.applicability, ["paths", "kinds"]) && !exact(b.applicability, ["paths", "kinds", "basename"])) || (b.applicability.basename !== undefined && (!safeBasename(b.applicability.basename) || !b.applicability.paths.includes(b.applicability.basename))) || !paths(b.applicability.paths) || !b.applicability.paths.length || !Array.isArray(b.applicability.kinds) || !b.applicability.kinds.length || new Set(b.applicability.kinds).size !== b.applicability.kinds.length || !b.applicability.kinds.every(k => k === "added" || k === "modified") ||
            !exact(b.exceptions, ["paths", "legacy"]) || !paths(b.exceptions.paths) || typeof b.exceptions.legacy !== "boolean" ||
            (b.validator === "new-file-placement" ? !exact(b.placement, ["prefix"]) || !safePath(b.placement.prefix) || b.applicability.kinds.some(k => k !== "added") : b.placement !== undefined))
            throw new Error("Invalid local binding values");
        return Object.freeze({ version: 1, validator: b.validator, rule: Object.freeze({ ...b.rule }), applicability: Object.freeze({ paths: Object.freeze([...b.applicability.paths]), kinds: Object.freeze([...b.applicability.kinds]), ...(b.applicability.basename === undefined ? {} : { basename: b.applicability.basename }) }), exceptions: Object.freeze({ paths: Object.freeze([...b.exceptions.paths]), legacy: b.exceptions.legacy }), ...(b.placement ? { placement: Object.freeze({ ...b.placement }) } : {}) });
    }));
}
const DEFAULT_BUDGET = 100;
export const PROACTIVE_LIMITS = Object.freeze({ maxUnits: 20, maxRetainedBytes: 256 * 1024, maxStateBytes: 32 * 1024, maxQuestions: 16, maxCallsPerTurn: 2, captureMs: 1000, maxFileBytes: 64 * 1024 });
const keys = new Set(["version", "mode", "remoteContext", "include", "maxEvaluationsPerSession", "localBindings"]);
const OFF = Object.freeze({ version: 1, mode: "off", remoteContext: "disabled", include: Object.freeze([]), maxEvaluationsPerSession: 0 });
function includePath(value) {
    if (typeof value !== "string" || !value || value.length > 256 || value.startsWith("/") || value.startsWith(".") || value.includes("\\") || value.includes("\0") || /[{}!\[\]?]/.test(value))
        return false;
    const segments = value.split("/");
    return segments.every(s => !!s && s !== ".." && s !== "." && !s.startsWith(".")) && !segments.some(s => /^(node_modules|vendor|dist|build|coverage|\.git|\.pi)$/i.test(s)) && (segments.length > 1 || !value.includes("*"));
}
export function parseProactiveConfig(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new Error("Invalid proactive review config");
    const v = value;
    if (Object.keys(v).some(k => !keys.has(k)) || v.version !== 1 || !["off", "shadow", "advisory"].includes(String(v.mode)))
        throw new Error("Unsupported proactive review config");
    if (v.remoteContext !== undefined && v.remoteContext !== "disabled" && v.remoteContext !== "selected-excerpts")
        throw new Error("Invalid remoteContext");
    if (v.include !== undefined && (!Array.isArray(v.include) || v.include.length > 32 || !v.include.every(includePath) || new Set(v.include).size !== v.include.length))
        throw new Error("Invalid include scope");
    const bindings = v.localBindings === undefined ? undefined : parseLocalBindings(v.localBindings);
    const budget = v.maxEvaluationsPerSession ?? DEFAULT_BUDGET;
    if (!Number.isSafeInteger(budget) || Number(budget) < 0 || Number(budget) > 100)
        throw new Error("Invalid session budget");
    if (v.mode === "off") {
        if ((v.remoteContext && v.remoteContext !== "disabled") || (Array.isArray(v.include) && v.include.length) || bindings?.length || (v.maxEvaluationsPerSession !== undefined && budget !== 0))
            throw new Error("Off config must not authorize capture");
        return OFF;
    }
    if (!Array.isArray(v.include) || !v.include.length)
        throw new Error("Explicit include scope required");
    return Object.freeze({ version: 1, mode: v.mode, remoteContext: (v.remoteContext ?? "disabled"), include: Object.freeze([...v.include]), maxEvaluationsPerSession: Number(budget), ...(bindings ? { localBindings: bindings } : {}) });
}
