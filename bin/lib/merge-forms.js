// merge-forms.js — the two artifact forms that share a file with the user.
//
// Every other strategy owns its target outright: the file is a copy, a link, or
// generated output, and comparing it is comparing bytes. These two are not.
//
//   • a managed region is a sentinel-bounded block inside a file whose other
//     lines belong to the user (the `justfile` harness recipes);
//   • a JSON merge sets named key paths inside a file whose other keys belong
//     to the user (`.claude/settings.json`).
//
// Both need the same three operations — locate our part, compare our part,
// rewrite our part — and both `verify` and `apply` need them. They live here
// so the reader and the writer cannot disagree about where our part ends;
// putting them in either module would make the two import each other.

// `[ \t]*$` rather than `\s*$` on purpose: `\s` matches newlines, and a greedy
// trailing `\s*` swallows the line break after the closing sentinel whenever
// one is there to swallow. The same region then hashes differently depending on
// whether it sits mid-file or at EOF, which reads as drift on every re-run.
const REGION_OPEN = /^#[ \t]*>>>[ \t]*agent-fleet:(\S+).*>>>[ \t]*$/m;

const regionClose = (name) =>
  new RegExp(`^#[ \\t]*<<<[ \\t]*agent-fleet:${escapeRe(name)}[ \\t]*<<<[ \\t]*$`, "m");

/**
 * Find the agent-fleet region in a file's text.
 *
 * @returns {{name: string, block: string, start: number, end: number}|null}
 *   null when there is no region, or the opening sentinel has no match — an
 *   unterminated region is not a region we may rewrite.
 */
export function extractRegion(text) {
  if (typeof text !== "string") return null;
  const open = text.match(REGION_OPEN);
  if (!open) return null;
  const close = text.match(regionClose(open[1]));
  if (!close || close.index < open.index) return null;
  const end = close.index + close[0].length;
  return { name: open[1], block: text.slice(open.index, end), start: open.index, end };
}

/**
 * Put `block` into `existing`, replacing a region already there or appending
 * one if not. Everything outside the sentinels is preserved verbatim — this is
 * what lets a workspace keep its own recipes across an upgrade that prunes
 * retired ones.
 */
export function replaceRegion(existing, block) {
  const found = extractRegion(existing);
  if (found) return existing.slice(0, found.start) + block + existing.slice(found.end);
  const head = (existing ?? "").trimEnd();
  return head.length > 0 ? `${head}\n\n${block}\n` : `${block}\n`;
}

/**
 * Take our region out of `existing`, leaving the user's lines. Used when the
 * last item that owned the region is removed: leaving the block behind is worse
 * than deleting the file, because `just --list` keeps offering recipes for
 * harness directories that are no longer installed.
 *
 * @returns {string|null} the remaining text, or null when nothing is left of it
 */
export function stripRegion(existing) {
  const found = extractRegion(existing);
  if (!found) return existing ?? null;
  const rest = (existing.slice(0, found.start) + existing.slice(found.end)).trim();
  return rest.length > 0 ? `${rest}\n` : null;
}

/**
 * `[[path, value], …]` for every leaf of an object — arrays and primitives are
 * leaves, plain objects are walked. These paths are exactly what a merge sets
 * and what the state file records, so setting a whole subtree is impossible by
 * construction.
 */
export function leafPaths(value, trail = []) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [[trail, value]];
  return Object.entries(value).flatMap(([k, v]) => leafPaths(v, [...trail, k]));
}

export function getPath(obj, path) {
  let node = obj;
  for (const key of path) {
    if (node === null || typeof node !== "object") return undefined;
    node = node[key];
  }
  return node;
}

export function setPath(obj, path, value) {
  let node = obj;
  for (const key of path.slice(0, -1)) {
    if (node[key] === null || typeof node[key] !== "object" || Array.isArray(node[key])) node[key] = {};
    node = node[key];
  }
  node[path[path.length - 1]] = value;
}

/** Stable serialisation for hashing a JSON value. */
export function canonicalJson(value) {
  return JSON.stringify(value ?? null);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
