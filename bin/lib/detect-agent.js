// Coding agent identity for the installer.
//
// pi is the only coding agent Agent Fleet installs for. Claude Code still
// appears in the fleet, but strictly as a coms peer driven by
// scripts/coms-claude-bridge.ts — never as an install target. See
// docs/claude-code-coms-bridge.md.
//
// The list and the detection hook stay because the manifest, the state file,
// and every CLI verb are written per-agent: a second runtime would be a new
// entry here, not a reshape of the engine.

export const AGENTS = ["pi"];

export const DEFAULT_AGENT = "pi";

const LABELS = {
  "pi": "pi",
};

export function agentLabel(agent) {
  return LABELS[agent] ?? agent;
}

/**
 * Resolve the coding agent for a workspace.
 *
 * With a single supported runtime there is nothing to detect — every caller
 * gets `pi`. The signature is unchanged so call sites keep reading as "ask,
 * don't assume" if a second agent is ever added back.
 */
export function detectAgent() {
  return DEFAULT_AGENT;
}
