import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { excerpt, inventory, PathOutsideAllowedRootError, readback, snapshotSource } from "./deterministic-fs.ts";
import { readActiveProfile } from "./policy/profile-runtime.ts";
import { resolveAssist } from "./assist-profile.ts";

export const FILESYSTEM_SESSION_DIR_ENV = "AGENT_FLEET_FILESYSTEM_SESSION_DIR";

export interface FilesystemToolPorts { enabled(): boolean; sessionDir(): string }

function workspacePath(path: string, cwd: string): string {
 const target=resolve(cwd,path), rel=relative(cwd,target);
 if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Path outside current workspace: ${path}`);
 if (existsSync(target)) {
  const realRel=relative(realpathSync(cwd),realpathSync(target));
  if (realRel.startsWith("..") || isAbsolute(realRel)) throw new Error(`Symlink escape outside current workspace: ${path}`);
 }
 return target;
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
  description: "Deterministically inventory or excerpt repository files, read back an opaque handle, or snapshot a local source into this session's managed untrusted artifacts. No network or model delegation.",
  parameters: Type.Object({
   operation: Type.Union([Type.Literal("inventory"),Type.Literal("excerpt"),Type.Literal("readback"),Type.Literal("snapshot")]),
   path: Type.Optional(Type.String({description:"Local path inside the current workspace; required except for readback."})),
   handle: Type.Optional(Type.String({description:"Opaque handle returned by inventory, excerpt, snapshot, or prior readback."})),
   origin: Type.Optional(Type.Literal("file",{description:"Snapshots accept local file sources only."})),
   page_size: Type.Optional(Type.Integer({minimum:1})),
   max_bytes: Type.Optional(Type.Integer({minimum:1})),
  }, { additionalProperties: false }),
  async execute(_id, raw, _signal, _update, ctx) {
   if (!ports.enabled()) throw new Error("filesystem is disabled by the effective profile; set assist.deterministic-tools=true");
   const params=raw as any, cwd=resolve(ctx.cwd || process.cwd()), sessionValue=ports.sessionDir();
   if (!sessionValue) throw new Error("filesystem requires a current managed session artifact root");
   const session=resolve(sessionValue);
   if (existsSync(session) && lstatSync(session).isSymbolicLink()) throw new Error("filesystem refuses a symlinked managed session root");
   if (params.destination !== undefined) throw new Error("filesystem snapshot destination is managed and cannot be supplied");
   switch(params.operation) {
    case "inventory": if(!params.path) throw new Error("inventory requires path"); return result(inventory({root:workspacePath(params.path,cwd),handle:params.handle,pageSize:params.page_size,boundedOutput:true}));
    case "excerpt": if(!params.path) throw new Error("excerpt requires path"); return result(excerpt({path:workspacePath(params.path,cwd),allowedRoot:cwd,handle:params.handle,maxBytes:params.max_bytes,boundedOutput:true}));
    case "readback": {
     if(!params.handle) throw new Error("readback requires handle");
     try { return result(readback({handle:params.handle,allowedRoot:cwd,maxBytes:params.max_bytes,boundedOutput:true})); }
     catch (error) {
      if (!(error instanceof PathOutsideAllowedRootError)) throw error;
      return result(readback({handle:params.handle,allowedRoot:session,maxBytes:params.max_bytes,boundedOutput:true}));
     }
    }
    case "snapshot": if(params.origin!=="file" || !params.path) throw new Error("snapshot accepts a local file origin and path only"); return result(snapshotSource({origin:"file",path:workspacePath(params.path,cwd),allowedRoot:cwd,sessionDir:session}));
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
