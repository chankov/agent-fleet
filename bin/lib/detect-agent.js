// Agent detection — used by `agent-skills init` to pick a sensible default
// for the coding agent. The user can always override with --agent.

import { existsSync } from "node:fs";
import { join } from "node:path";

export const AGENTS = ["claude-code", "opencode", "pi"];

const LABELS = {
  "claude-code": "Claude Code",
  "opencode":    "OpenCode",
  "pi":          "pi",
};

export function agentLabel(agent) {
  return LABELS[agent] ?? agent;
}

// Detection precedence (default):
//   1. Explicit env vars from the coding agent runtime
//   2. Workspace directory hints (.claude/ / .opencode/ / .pi/)
//   3. Null — let the caller prompt
//
// `preferWorkspaceHints` flips 1 and 2. `update` uses it: the question there
// is "which agent is *this workspace* configured for?", not "which agent am I
// running inside?" — so a pi workspace must not resolve to claude-code just
// because `update` was invoked from a Claude Code shell.
export function detectAgent({ workspace, env = process.env, preferWorkspaceHints = false } = {}) {
  const byEnv = () => {
    if (env.CLAUDECODE === "1" || env.CLAUDE_CODE_ENTRYPOINT) return "claude-code";
    if (env.OPENCODE === "1" || env.OPENCODE_VERSION)         return "opencode";
    if (env.PI === "1" || env.PI_SESSION_ID)                  return "pi";
    return null;
  };

  const byWorkspace = () => {
    // Only one match → pick it; multiple → don't guess.
    if (!workspace) return null;
    const hits = [];
    if (existsSync(join(workspace, ".claude"))) hits.push("claude-code");
    if (existsSync(join(workspace, ".opencode"))) hits.push("opencode");
    if (existsSync(join(workspace, ".pi"))) hits.push("pi");
    return hits.length === 1 ? hits[0] : null;
  };

  return preferWorkspaceHints
    ? (byWorkspace() ?? byEnv())
    : (byEnv() ?? byWorkspace());
}
