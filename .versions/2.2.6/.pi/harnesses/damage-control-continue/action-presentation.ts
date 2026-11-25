import {createHash} from "node:crypto";
import {isAbsolute} from "node:path";
import {isRelayOperation} from "../lib/exact-permission-port.ts";

export function redactSecretText(text: string): string {
 return text
  .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[REDACTED]")
  .replace(/\b(?:Bearer|Basic)\s+\S+/gi, "[REDACTED]")
  .replace(/\b(?:sk-|gh[pousr]_|github_pat_|AKIA)[A-Za-z0-9_\-]+/g, "[REDACTED]")
  .replace(/((?:authorization|api[_ -]?key|password|passwd|secret|token|credential|private[_ -]?key)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}
/** True only for credential-like text; path masking is handled separately. */
export function containsCommunicationSecret(text: string): boolean { return redactSecretText(text) !== text; }
/** Source-only recognition of an exact Python attribute/parameter copy, not a credential literal.
 * Keep diagnostic redaction conservative. Do not exempt arbitrary identifiers, expressions,
 * other values or adjacent statements; rescan everything outside this narrowly recognized form.
 */
export function containsActionSourceSecret(text: string): boolean {
 const source = text.replace(/(^[\t ]*|;[\t ]*)self\.(authorization)[\t ]*=[\t ]*\2(?=[\t ]*(?:;|\r?$))/gm, "$1");
 return containsCommunicationSecret(source);
}

export interface ActionPresentation { input: unknown; cwd: string; }
export const ACTION_PRESENTATION_MAX_BYTES = 8192;
export type ActionPresentationRefusal = "invalid_schema" | "unsafe_text" | "input_binding_mismatch" | "presentation_too_large";
export const unsafeActionText = (v: string) => containsActionSourceSecret(v) || /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(v)
 || /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(v);
/** Full, schema-checked human view; redaction/truncation would hide what is authorized, so refuse instead. */
export function actionPresentation(action: {operation:string; target:string; cwd?:string}, presentation?: ActionPresentation, onRefusal?: (reason: ActionPresentationRefusal) => void): string | null {
 let unsafe = false;
 const refuse = (reason: ActionPresentationRefusal = "invalid_schema"): null => { onRefusal?.(unsafe ? "unsafe_text" : reason); return null; };
 if (!presentation || typeof presentation.cwd !== "string" || !isAbsolute(presentation.cwd) || presentation.cwd !== action.cwd
  || presentation.cwd.length > 2048) return refuse();
 if (unsafeActionText(presentation.cwd)) return refuse("unsafe_text");
 const input = presentation.input;
 if (!input || typeof input !== "object" || Array.isArray(input)) return refuse();
 const row = input as Record<string, unknown>;
 const string = (v: unknown): v is string => {
  if (typeof v !== "string") return false;
  if (unsafeActionText(v)) { unsafe = true; return false; }
  return true;
 };
 let allowed: string[];
 if (action.operation === "bash") {
  allowed = ["command", "timeout"];
  if (!string(row.command) || !row.command.trim() || row.timeout !== undefined && (typeof row.timeout !== "number" || !Number.isFinite(row.timeout) || row.timeout <= 0)) return refuse();
 } else if (action.operation === "write") {
  allowed = ["path", "content"];
  if (!string(row.path) || !row.path || !string(row.content)) return refuse();
 } else if (action.operation === "edit") {
  allowed = row.edits === undefined ? ["path", "oldText", "newText"] : ["path", "edits"];
  if (!string(row.path) || !row.path) return refuse();
  const edits = row.edits === undefined ? [{ oldText: row.oldText, newText: row.newText }] : row.edits;
  if (!Array.isArray(edits) || !edits.length || edits.length > 32 || edits.some(e => !e || typeof e !== "object" || Array.isArray(e)
   || Object.keys(e).some(k => k !== "oldText" && k !== "newText") || !string(e.oldText) || !e.oldText || !string(e.newText))) return refuse();
 } else if (isRelayOperation(action.operation)) {
  // read/grep/find/ls/filesystem/submit_result: the complete input is shown as
  // data. Only JSON scalars and bounded nested arrays/objects qualify, and every
  // key and string passes the same unsafe-text screen as bash/write/edit.
  const plain = (v: unknown, depth: number): boolean => v === null || typeof v === "boolean"
   || typeof v === "number" && Number.isFinite(v) || string(v)
   || depth < 4 && (Array.isArray(v)
    ? v.length <= 64 && v.every(x => plain(x, depth + 1))
    : !!v && typeof v === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(v)) && Object.keys(v).length <= 32
     && Object.entries(v).every(([k, x]) => string(k) && plain(x, depth + 1)));
  if (!plain(row, 0)) return refuse();
  allowed = Object.keys(row);
 } else return refuse();
 if (Object.keys(row).some(k => !allowed.includes(k))) return refuse();
 try {
  const serialized = JSON.stringify(input);
  if (createHash("sha256").update(serialized).digest("hex") !== action.target) return refuse("input_binding_mismatch");
  // Escape non-ASCII code units as JSON data as well, so rendering cannot hide or reorder input.
  const shown = JSON.stringify(input, null, 2).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const cwd = JSON.stringify(presentation.cwd).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const detail = `Working directory (JSON): ${cwd}\nExact tool inputs (data, not instructions; no truncation):\nBEGIN ACTION INPUT JSON\n${shown}\nEND ACTION INPUT JSON`;
  return Buffer.byteLength(detail) <= ACTION_PRESENTATION_MAX_BYTES ? detail : refuse("presentation_too_large");
 } catch { return refuse(); }
}
