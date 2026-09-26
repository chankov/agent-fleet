// Preserve user-authored override sections while deterministically refreshing generated facts.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { OVERRIDES_REL_PATH } from "./validate-overrides.js";

export function generatedOverrideSection(scan) {
  const lines = [];
  if (scan.rules.length) lines.push(`rules: ${scan.rules.join(", ")}`);
  if (scan.docs.length) lines.push(`docs: ${scan.docs.join(", ")}`);
  return lines.length ? `## agent-hub\n${lines.join("\n")}\n` : "";
}

/** Replace only generated agent-hub keys, retaining all unknown/hand-written text. */
export function mergeOverrides(existing, scan, { configure = false } = {}) {
  if (configure) {
    const source = existing ?? "";
    const eol = source.includes("\r\n") ? "\r\n" : "\n";
    const sections = [...source.matchAll(/^##\s+(agent-hub|agent-team)\s*$/gm)];
    if (sections.length > 1) throw new Error("conflicting agent-hub/agent-team sections; resolve manually");
    const start = sections[0]?.index;
    const end = start === undefined ? source.length : source.slice(start + sections[0][0].length).search(/^##\s+/m);
    const stop = start === undefined ? source.length : end < 0 ? source.length : start + sections[0][0].length + end;
    const section = start === undefined ? "" : source.slice(start, stop);
    let updated = section;
    for (const key of ["rules", "docs"]) {
      if (!Object.hasOwn(scan, key)) continue;
      const matches = [...updated.matchAll(new RegExp(`^${key}:\\s*(.*)$`, "gm"))];
      if (matches.length > 1) throw new Error(`duplicate ${key} keys; resolve manually`);
      const current = matches[0]?.[1].split(",").map((v) => v.trim()).filter(Boolean) ?? [];
      const merged = [...new Set([...current, ...scan[key]])];
      const line = `${key}: ${merged.join(", ")}`;
      if (matches.length) {
        if (merged.length !== current.length || current.join(", ") !== matches[0][1].trim())
          updated = updated.slice(0, matches[0].index) + line + updated.slice(matches[0].index + matches[0][0].length);
      } else if (merged.length) updated = updated.replace(/\s*$/, "") + eol + line + eol;
    }
    if (updated === section) return source;
    if (start === undefined) return source + (source && !source.endsWith(eol) ? eol : "") + `## agent-hub${eol}` + updated.trimStart();
    return source.slice(0, start) + updated + source.slice(stop);
  }
  const generated = generatedOverrideSection(scan);
  if (!generated) return existing ?? "";
  const source = existing ?? "";
  const sections = source.split(/(?=^##\s)/m);
  let found = false;
  const merged = sections.map((section) => {
    if (!/^##\s+agent-hub\s*$/m.test(section)) return section;
    found = true;
    const retained = section.split("\n").filter((line) => !/^(rules|docs):\s*/.test(line)).join("\n").replace(/\n+$/, "");
    return `${retained}\n${generated.replace(/^## agent-hub\n/, "")}`;
  });
  if (!found) merged.push(generated);
  return merged.join("").replace(/^\n+/, "").replace(/\n*$/, "\n");
}

export function planConfigureOverrides(workspace, requested, expectedHash = null) {
  const path = join(workspace, OVERRIDES_REL_PATH);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const hash = createHash("sha256").update(existing).digest("hex");
  if (expectedHash !== null && expectedHash !== hash) throw new Error("workspace changed since preview: overrides; re-run configure --dry-run");
  const text = mergeOverrides(existing, requested, { configure: true });
  return { path, text, write: text !== existing, hash };
}

export function planOverrides(workspace, scan) {
  const path = join(workspace, OVERRIDES_REL_PATH);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  // A configured overrides file is human-owned; setup must never touch it.
  if (existing.trim() !== "") return { path, text: existing, write: false };
  const text = mergeOverrides(existing, scan);
  return { path, text, write: text !== existing };
}
