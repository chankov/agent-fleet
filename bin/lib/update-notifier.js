// update-notifier — zero-dependency check for newer versions on the npm
// registry, shared by the CLI, the Claude Code session hook, and the pi
// extension.
//
// Behaviour:
//   - Cache lives at $XDG_CACHE_HOME/agent-skills/latest-version.json
//     (falls back to ~/.cache/agent-skills/) with a 24h TTL.
//   - The CLI invokes checkAndNotify() at the top of every command. If the
//     cache is fresh and shows an upgrade, we print a banner immediately.
//     If the cache is stale or absent, we start a background fetch (detached,
//     non-blocking) and use whatever we have right now.
//   - Network failures, JSON parse errors, and missing cache files are all
//     swallowed silently — update checks must NEVER block the CLI or break
//     a hook.
//   - Opt-out: AGENT_SKILLS_NO_UPDATE_CHECK=1 in the environment disables
//     everything in this module.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { request } from "node:https";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@chankov/agent-skills";
const REGISTRY = "https://registry.npmjs.org";
const TTL_MS = 24 * 60 * 60 * 1000;

const CACHE_DIR = join(
  process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
  "agent-skills",
);
const CACHE_FILE = join(CACHE_DIR, "latest-version.json");

// ── Public surface ───────────────────────────────────────────────────────

/**
 * Run the standard check + banner flow used by the CLI.
 *
 * @param {string} currentVersion  The version of the running CLI
 * @param {object} [opts]
 * @param {boolean} [opts.silent]  If true, return the banner string instead of printing
 * @returns {string|null}  The banner that would be (or was) printed
 */
export function checkAndNotify(currentVersion, opts = {}) {
  if (isDisabled()) return null;

  const cached = readCache();
  const fresh = cached && Date.now() - cached.checkedAt < TTL_MS;

  if (!fresh) startBackgroundFetch();

  const latest = cached?.latest;
  if (!latest || !gt(latest, currentVersion)) return null;

  const banner = formatBanner(currentVersion, latest);
  if (!opts.silent) process.stderr.write(banner + "\n");
  return banner;
}

/**
 * Synchronously fetch the latest version, write the cache, and return it.
 * Used by the standalone check-update entry point (hooks block on this
 * intentionally — they need the answer before the session continues).
 *
 * @param {number} [timeoutMs]   Default 2000ms — hooks must not stall the UI
 * @returns {Promise<string|null>}
 */
export async function fetchLatestSync(timeoutMs = 2000) {
  if (isDisabled()) return null;
  try {
    const latest = await fetchLatest(timeoutMs);
    writeCache({ latest, checkedAt: Date.now() });
    return latest;
  } catch {
    return null;
  }
}

/**
 * Read the cached latest version without touching the network. Hook scripts
 * use this on the fast path — if the cache is fresh, no fetch is needed.
 *
 * @returns {{latest:string, checkedAt:number, stale:boolean}|null}
 */
export function readCacheStatus() {
  const c = readCache();
  if (!c) return null;
  return { ...c, stale: Date.now() - c.checkedAt >= TTL_MS };
}

export function formatBanner(current, latest) {
  const lines = [
    `agent-skills update available: ${current} → ${latest}`,
    `  Run: npx ${PACKAGE_NAME}@latest update`,
    `  Releases: https://github.com/chankov/agent-skills/releases`,
  ];
  const w = Math.max(...lines.map((l) => l.length)) + 2;
  const bar = "─".repeat(w);
  return [
    `┌${bar}┐`,
    ...lines.map((l) => `│ ${l.padEnd(w - 1)}│`),
    `└${bar}┘`,
  ].join("\n");
}

// ── Internals ────────────────────────────────────────────────────────────

function isDisabled() {
  return process.env.AGENT_SKILLS_NO_UPDATE_CHECK === "1"
      || process.env.CI === "true"   // never spam CI logs
      || process.env.NO_UPDATE_NOTIFIER === "1";  // honour the common convention
}

function readCache() {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    return JSON.parse(readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeCache(payload) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(payload, null, 2), "utf8");
  } catch {
    // Read-only home dir, full disk, etc. — caching is best-effort.
  }
}

function fetchLatest(timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = `${REGISTRY}/${encodeURIComponent(PACKAGE_NAME).replace("%40", "@")}/latest`;
    const req = request(url, { method: "GET", headers: { accept: "application/json" } }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`registry returned ${res.statusCode}`));
        res.resume();
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          if (typeof parsed.version !== "string") throw new Error("missing version field");
          resolve(parsed.version);
        } catch (err) { reject(err); }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("timeout"));
    });
    req.end();
  });
}

function startBackgroundFetch() {
  // Detached worker: never blocks the CLI, never inherits stdio.
  // We re-enter this module via dynamic import in a fresh node process and
  // run fetchLatestSync there — keeps the parent CLI exit unaffected.
  try {
    const modPath = fileURLToPath(import.meta.url);
    const child = spawn(process.execPath, [
      "-e",
      `import(${JSON.stringify(modPath)}).then(m => m.fetchLatestSync(8000)).catch(() => {})`,
    ], { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // If spawn fails (e.g. restricted env), skip — the next CLI run will retry.
  }
}

// ── Tiny semver-gt comparator ────────────────────────────────────────────
// Enough for X.Y.Z comparisons; anything pre-release falls back to string
// compare on the suffix, which is good enough for "is the user behind?"

export function gt(a, b) {
  const [aMain, aPre = ""] = a.split("-", 2);
  const [bMain, bPre = ""] = b.split("-", 2);
  const aParts = aMain.split(".").map(Number);
  const bParts = bMain.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const ai = aParts[i] ?? 0;
    const bi = bParts[i] ?? 0;
    if (ai !== bi) return ai > bi;
  }
  // Equal main versions: a release (no prerelease) outranks a prerelease.
  if (!aPre && bPre) return true;
  if (aPre && !bPre) return false;
  return aPre > bPre;
}
