import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProactiveConfig } from "./proactive-types.ts";
import { parseLocalBindings, type ReviewedLocalBinding } from "./proactive-local.ts";
export type LocalProactiveConfig = ProactiveConfig & { readonly localBindings?: readonly ReviewedLocalBinding[] };

const DEFAULT_BUDGET = 100;
export const PROACTIVE_LIMITS = Object.freeze({ maxUnits: 20, maxRetainedBytes: 256 * 1024, maxStateBytes: 32 * 1024, maxQuestions: 16, maxCallsPerTurn: 2, captureMs: 1000, maxFileBytes: 64 * 1024 });
const keys = new Set(["version", "mode", "remoteContext", "include", "maxEvaluationsPerSession", "localBindings"]);
const OFF: ProactiveConfig = Object.freeze({ version: 1, mode: "off", remoteContext: "disabled", include: Object.freeze([]), maxEvaluationsPerSession: 0 });

function includePath(value: unknown): value is string {
 if (typeof value !== "string" || !value || value.length > 256 || value.startsWith("/") || value.startsWith(".") || value.includes("\\") || value.includes("\0") || /[{}!\[\]?]/.test(value)) return false;
 const segments = value.split("/");
 return segments.every(s => !!s && s !== ".." && s !== "." && !s.startsWith(".")) && !segments.some(s => /^(node_modules|vendor|dist|build|coverage|\.git|\.pi)$/i.test(s)) && (segments.length > 1 || !value.includes("*"));
}
export function parseProactiveConfig(value: unknown): LocalProactiveConfig {
 if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid proactive review config");
 const v = value as Record<string, unknown>;
 if (Object.keys(v).some(k => !keys.has(k)) || v.version !== 1 || !["off", "shadow", "advisory"].includes(String(v.mode))) throw new Error("Unsupported proactive review config");
 if (v.remoteContext !== undefined && v.remoteContext !== "disabled" && v.remoteContext !== "selected-excerpts") throw new Error("Invalid remoteContext");
 if (v.include !== undefined && (!Array.isArray(v.include) || v.include.length > 32 || !v.include.every(includePath) || new Set(v.include).size !== v.include.length)) throw new Error("Invalid include scope");
 const bindings = v.localBindings === undefined ? undefined : parseLocalBindings(v.localBindings);
 const budget = v.maxEvaluationsPerSession ?? DEFAULT_BUDGET;
 if (!Number.isSafeInteger(budget) || Number(budget) < 0 || Number(budget) > 100) throw new Error("Invalid session budget");
 if (v.mode === "off") {
  if ((v.remoteContext && v.remoteContext !== "disabled") || (Array.isArray(v.include) && v.include.length) || bindings?.length || (v.maxEvaluationsPerSession !== undefined && budget !== 0)) throw new Error("Off config must not authorize capture");
  return OFF;
 }
 if (!Array.isArray(v.include) || !v.include.length) throw new Error("Explicit include scope required");
 return Object.freeze({ version: 1, mode: v.mode as "shadow" | "advisory", remoteContext: (v.remoteContext ?? "disabled") as ProactiveConfig["remoteContext"], include: Object.freeze([...v.include]), maxEvaluationsPerSession: Number(budget), ...(bindings ? { localBindings: bindings } : {}) });
}
/** Read consumer config only. Missing means off; malformed config fails closed. Never inspect source here. */
export function loadProactiveConfig(repo: string): LocalProactiveConfig {
 let raw: string;
 try { raw = readFileSync(join(repo, ".ai/proactive-review.json"), "utf8"); }
 catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return OFF; throw error; }
 return parseProactiveConfig(JSON.parse(raw));
}
export function isCaptureEnabled(config: ProactiveConfig): boolean { return config.mode === "shadow" || config.mode === "advisory"; }
