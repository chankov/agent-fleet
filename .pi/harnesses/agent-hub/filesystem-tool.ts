import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { deterministicHandlePath } from "../lib/deterministic-handle-path.ts";
import { CONTENT_REPLY_BYTES, excerpt, inventory, PathOutsideAllowedRootError, readback, snapshotSource } from "./deterministic-fs.ts";
import { readActiveProfile } from "./policy/profile-runtime.ts";
import { resolveAssist } from "./assist-profile.ts";

export const FILESYSTEM_SESSION_DIR_ENV = "AGENT_FLEET_FILESYSTEM_SESSION_DIR";

export interface FilesystemToolPorts { enabled(): boolean; sessionDir(): string; readOnly?(): boolean; remainingSelfReadBytes?(): number; noteSelfReadBytes?(bytes: number): void; managedReadbackAllowed?(handle:string):boolean }

function workspacePath(path: string, cwd: string): string {
 const target=resolve(cwd,path), rel=relative(cwd,target);
 if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Path outside current workspace: ${path}`);
 if (existsSync(target)) {
  const realRel=relative(realpathSync(cwd),realpathSync(target));
  if (realRel.startsWith("..") || isAbsolute(realRel)) throw new Error(`Symlink escape outside current workspace: ${path}`);
 }
 return target;
}

function inside(root: string, target: string): boolean {
 const rel = relative(resolve(root), resolve(target));
 return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}
function fileBytes(path: string): number | null {
 if (!existsSync(path)) return null;
 const size = statSync(path);
 return size.isFile() ? size.size : null;
}
function tooLarge(path: string): { path: string; bytes: number } | null {
 const bytes = fileBytes(path);
 return bytes != null && bytes > CONTENT_REPLY_BYTES ? { path, bytes } : null;
}
function tooLargeRefusal(path: string, bytes: number) {
 return { refused: true, reason: "too_large", path, bytes, limitBytes: CONTENT_REPLY_BYTES, content: null, instruction: "Do not pull this into the dispatcher context. The orchestrator self-read ceiling is 64 KiB for one file and 64 KiB for the turn. Call spawn_research for a summary, or dispatch_agent with the path only. Do not paste contents and do not retry excerpt, readback, or inventory." };
}
function admit(ports: FilesystemToolPorts, readOnly: boolean, path: string, payload: any) {
 const body = payload?.content && Buffer.isBuffer(payload.content) ? { ...payload, content: payload.content.toString("utf8"), contentEncoding: "utf8", exactBytesOnDisk: payload.path } : payload;
 if (!readOnly || !ports.noteSelfReadBytes) return body;
 const bytes = Buffer.byteLength(JSON.stringify(body));
 if (bytes > (ports.remainingSelfReadBytes?.() ?? 0)) return tooLargeRefusal(path, bytes);
 ports.noteSelfReadBytes(bytes);
 return body;
}
function result(value: any) {
 const normalized = value?.content && Buffer.isBuffer(value.content)
  ? { ...value, content: value.content.toString("utf8"), contentEncoding: "utf8", exactBytesOnDisk: value.path }
  : value;
 return { content: [{ type: "text" as const, text: JSON.stringify(normalized) }], details: { result: normalized } };
}

export function registerFilesystemTool(pi: ExtensionAPI, ports: FilesystemToolPorts): void {
 pi.registerTool({
  name: "filesystem",
  label: "Deterministic Filesystem",
  description: "Deterministically stat, inventory, or excerpt repository files, or read back an opaque handle. Orchestrator may use those read-only operations without assist.deterministic-tools. In orchestrator mode, stat before excerpt; files above 64 KiB return no body and must go to spawn_research or dispatch_agent by path. Snapshot into this session's managed artifacts requires that profile. No network, shell, or arbitrary write.",
  parameters: Type.Object({
   operation: Type.Union([Type.Literal("stat"),Type.Literal("inventory"),Type.Literal("excerpt"),Type.Literal("readback"),Type.Literal("snapshot")]),
   path: Type.Optional(Type.String({description:"Local path inside the current workspace; required except for readback."})),
   handle: Type.Optional(Type.String({description:"Opaque handle returned by inventory, excerpt, snapshot, or prior readback."})),
   origin: Type.Optional(Type.Literal("file",{description:"Snapshots accept local file sources only."})),
   page_size: Type.Optional(Type.Integer({minimum:1})),
   max_bytes: Type.Optional(Type.Integer({minimum:1})),
  }, { additionalProperties: false }),
  async execute(_id, raw, _signal, _update, ctx) {
   const profileEnabled = ports.enabled();
   const readOnly = ports.readOnly?.() === true;
   if (!profileEnabled && !readOnly) throw new Error("filesystem is disabled by the effective profile; set assist.deterministic-tools=true");
   const params=raw as any, cwd=resolve(ctx.cwd || process.cwd()), sessionValue=ports.sessionDir();
   if (!sessionValue) throw new Error("filesystem requires a current managed session artifact root");
   const session=resolve(sessionValue);
   if (existsSync(session) && lstatSync(session).isSymbolicLink()) throw new Error("filesystem refuses a symlinked managed session root");
   if (params.destination !== undefined) throw new Error("filesystem snapshot destination is managed and cannot be supplied");
   switch(params.operation) {
    case "stat": {
     if(!params.path) throw new Error("stat requires path");
     const target = workspacePath(params.path,cwd);
     if (!existsSync(target)) throw new Error(`Not found: ${params.path}`);
     const followed = statSync(target);
     const bytes = followed.isFile() ? followed.size : null;
     return result({ path: target, type: followed.isDirectory() ? "directory" : followed.isFile() ? "file" : "other", bytes, limitBytes: CONTENT_REPLY_BYTES, selfRead: bytes != null && bytes <= CONTENT_REPLY_BYTES });
    }
    case "inventory": {
     if(!params.path) throw new Error("inventory requires path");
     const root = workspacePath(params.path,cwd);
     const listed = inventory({root,handle:params.handle,pageSize:params.page_size,boundedOutput:true});
     return result(admit(ports, readOnly, root, listed));
    }
    case "excerpt": {
     if(!params.path) throw new Error("excerpt requires path");
     const target = workspacePath(params.path,cwd);
     if (readOnly) {
      const oversized = tooLarge(target);
      if (oversized) return result(tooLargeRefusal(oversized.path, oversized.bytes));
      const bytes = fileBytes(target) ?? 0;
      if (ports.noteSelfReadBytes && bytes > (ports.remainingSelfReadBytes?.() ?? 0)) return result(tooLargeRefusal(target, bytes));
     }
     const body = excerpt({path:target,allowedRoot:cwd,handle:params.handle,maxBytes:params.max_bytes,boundedOutput:true});
     return result(admit(ports, readOnly, target, body));
    }
    case "readback": {
     if(!params.handle) throw new Error("readback requires handle");
     if(ports.managedReadbackAllowed?.(params.handle)===false)throw new Error('Managed readback is stale or denied');
     if (readOnly) {
      let bound = "";
      try { bound = deterministicHandlePath(params.handle); } catch { /* readback reports an invalid handle */ }
      if (bound && (inside(cwd, bound) || inside(session, bound))) {
       const oversized = tooLarge(bound);
       if (oversized) return result(tooLargeRefusal(oversized.path, oversized.bytes));
       const bytes = fileBytes(bound) ?? 0;
       if (ports.noteSelfReadBytes && bytes > (ports.remainingSelfReadBytes?.() ?? 0)) return result(tooLargeRefusal(bound, bytes));
      }
     }
     try { return result(admit(ports, readOnly, cwd, readback({handle:params.handle,allowedRoot:cwd,maxBytes:params.max_bytes,boundedOutput:true}))); }
     catch (error) {
      if (!(error instanceof PathOutsideAllowedRootError)) throw error;
      return result(admit(ports, readOnly, session, readback({handle:params.handle,allowedRoot:session,maxBytes:params.max_bytes,boundedOutput:true})));
     }
    }
    case "snapshot":
     if (!profileEnabled) throw new Error("filesystem snapshot requires assist.deterministic-tools; orchestrator inspection is inventory, excerpt, and readback only");
     if(params.origin!=="file" || !params.path) throw new Error("snapshot accepts a local file origin and path only");
     return result(snapshotSource({origin:"file",path:workspacePath(params.path,cwd),allowedRoot:cwd,sessionDir:session}));
    default: throw new Error("Unsupported filesystem operation");
   }
  },
 });
}

export default function deterministicFilesystemExtension(pi: ExtensionAPI): void {
 registerFilesystemTool(pi, {
  enabled: () => resolveAssist(readActiveProfile()?.profile.assist)['deterministic-tools'],
  sessionDir: () => process.env[FILESYSTEM_SESSION_DIR_ENV] || "",
 });
}
