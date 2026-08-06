// Preserve user-authored override sections while deterministically refreshing generated facts.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OVERRIDES_REL_PATH } from "./validate-overrides.js";

export function generatedOverrideSection(scan) {
  const lines = [];
  if (scan.rules.length) lines.push(`rules: ${scan.rules.join(", ")}`);
  if (scan.docs.length) lines.push(`docs: ${scan.docs.join(", ")}`);
  return lines.length ? `## agent-hub\n${lines.join("\n")}\n` : "";
}

/** Replace only generated agent-hub keys, retaining all unknown/hand-written text. */
export function mergeOverrides(existing, scan) {
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

export function planOverrides(workspace, scan) {
  const path = join(workspace, OVERRIDES_REL_PATH);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const text = mergeOverrides(existing, scan);
  return { path, text, write: text !== existing };
}
