import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { resolveAssist } from "./assist-profile.ts";
import { boundOutput } from "./deterministic-fs.ts";
import { readActiveProfile } from "./policy/profile-runtime.ts";

const BOUNDED_TOOLS = new Set(["read", "grep", "find", "ls"]);
export const BOUNDED_OUTPUT_DIR_ENV = "AGENT_FLEET_BOUNDED_OUTPUT_DIR";

export function boundedOutputEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
 const active = readActiveProfile(env); const flags = resolveAssist(active?.profile.assist);
 return flags["bounded-output"];
}

export function boundToolResult(event: any, retentionDir: string) {
 if (!BOUNDED_TOOLS.has(String(event.toolName))) return undefined;
 const text = (event.content ?? []).filter((item: any) => item?.type === "text" && typeof item.text === "string").map((item: any) => item.text).join("\n");
 const bounded = boundOutput({ content: text, retentionDir, label: `${event.toolName}-${event.toolCallId || "result"}` });
 if (!bounded.truncated) return undefined;
 const nonText = (event.content ?? []).filter((item: any) => item?.type !== "text");
 return { content: [{ type: "text", text: bounded.reply }, ...nonText], details: { ...(event.details && typeof event.details === "object" ? event.details : {}), boundedOutput: { truncated: true, totalBytes: bounded.totalBytes, handle: bounded.handle, contentPath: bounded.contentPath, sha256: bounded.hash } } };
}

export default function registerBoundedOutput(pi: ExtensionAPI): void {
 if (!boundedOutputEnabled() || !process.env[BOUNDED_OUTPUT_DIR_ENV]) return;
 pi.on("tool_result", (event: any) => boundToolResult(event, process.env[BOUNDED_OUTPUT_DIR_ENV]!));
}
