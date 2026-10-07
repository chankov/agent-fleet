import { randomUUID } from "node:crypto";
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { safePathWithin } from "./helpers.ts";

/** Allocate rather than clear: another live session may own any existing directory. */
export function createEvidenceSession(cwd: string): string {
 const sessionId = randomUUID();
 const dir = safePathWithin(cwd, ".pi", "agent-sessions", "sessions", sessionId);
 mkdirSync(dir, { recursive: true, mode: 0o700 });
 writeFileSync(safePathWithin(dir, "session.json"), JSON.stringify({ sessionId, cwd, pid: process.pid, startedAt: new Date().toISOString() }, null, 2), { flag: "wx", mode: 0o600 });
 return dir;
}

/** Request/result are separate create-exclusive records; even failed and resumed runs survive. */
export function beginExecutionEvidence(sessionDir: string, dispatchId: string, request: object, inputs: { path: string }[] = []): string {
 const dir = safePathWithin(sessionDir, "dispatches", dispatchId);
 mkdirSync(dir, { recursive: true, mode: 0o700 });
 const retainedInputs = inputs.map((input, i) => {
  const retainedPath = safePathWithin(dir, `input-${i}`);
  copyFileSync(input.path, retainedPath, constants.COPYFILE_EXCL);
  return { path: input.path, retainedPath };
 });
 writeFileSync(safePathWithin(dir, "request.json"), JSON.stringify({ ...request, dispatchId, inputs: retainedInputs }, null, 2), { flag: "wx", mode: 0o600 });
 return dir;
}

export function finishExecutionEvidence<T extends object>(dir: string, result: T): T & { evidencePath: string } {
 const evidencePath = safePathWithin(dir, "result.json");
 const recorded = { ...result, evidencePath };
 writeFileSync(evidencePath, JSON.stringify(recorded, null, 2), { flag: "wx", mode: 0o600 });
 return recorded;
}

export function closeEvidenceSession(dir: string): void {
 // Never claim or mutate the legacy shared root.
 if (!existsSync(safePathWithin(dir, "session.json"))) return;
 const meta = JSON.parse(readFileSync(safePathWithin(dir, "session.json"), "utf8"));
 if (meta.sessionId !== basename(dir)) return;
 try { writeFileSync(safePathWithin(dir, "closed.json"), JSON.stringify({ closedAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 }); }
 catch (error: any) { if (error.code !== "EEXIST") throw error; }
}

function processAlive(pid: number): boolean {
 if (!Number.isSafeInteger(pid) || pid <= 0) return true;
 try { process.kill(pid, 0); return true; } catch (error: any) { return error.code !== "ESRCH"; }
}

/** Existing keep limit applies only to safely closed new namespaces. Unknown/live data is protected. */
export function pruneEvidenceSessions(sessionDir: string, keep: number | null, alive = processAlive): void {
 if (keep == null) return;
 const root = dirname(sessionDir);
 if (basename(root) !== "sessions") return;
 const eligible: { dir: string; closedAt: string }[] = [];
 for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
  const dir = safePathWithin(root, entry.name);
  try {
   const meta = JSON.parse(readFileSync(safePathWithin(dir, "session.json"), "utf8"));
   const closed = JSON.parse(readFileSync(safePathWithin(dir, "closed.json"), "utf8"));
   if (meta.sessionId !== entry.name || alive(meta.pid) || typeof closed.closedAt !== "string") continue;
   const dispatches = safePathWithin(dir, "dispatches");
   if (existsSync(dispatches) && readdirSync(dispatches).some(id => {
    const result = JSON.parse(readFileSync(safePathWithin(dispatches, id, "result.json"), "utf8"));
    return result.pending === true;
   })) continue;
   eligible.push({ dir, closedAt: closed.closedAt });
  } catch { /* Missing, malformed or unfinished evidence is never a pruning candidate. */ }
 }
 eligible.sort((a, b) => a.closedAt.localeCompare(b.closedAt) || a.dir.localeCompare(b.dir));
 for (const entry of eligible.slice(0, Math.max(0, eligible.length - keep))) rmSync(entry.dir, { recursive: true, force: true });
}

export function retainDeliverable(sessionDir: string, dispatchId: string, index: number, bytes: Buffer): string {
 const dir = safePathWithin(sessionDir, "dispatches", dispatchId, "deliverables");
 mkdirSync(dir, { recursive: true, mode: 0o700 });
 const path = safePathWithin(dir, String(index));
 writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
 return path;
}
