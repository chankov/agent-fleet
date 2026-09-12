import { runAgentPhase } from "./lib/agent-phase.ts";
import { ENVELOPE_EXAMPLES, validateEnvelope, type ScoutReport } from "./lib/envelopes.ts";
import { resolvePersona, type PersonaDefinition } from "./lib/personas.ts";
import type { PermissionPolicy } from "./lib/permissions.ts";
import type { FinishResult, Run } from "./lib/run.ts";

export const SCOUT_PERMISSION_POLICY: PermissionPolicy = { writes: [] };
export interface ScoutWorkflowDeps {
	agent?: (options: Parameters<typeof runAgentPhase<ScoutReport>>[0]) => Promise<ScoutReport>;
	persona?: PersonaDefinition;
}

export function scoutWorkflowPreflight(cwd: string): void {
	const persona = resolvePersona("researcher", cwd);
	const tools = persona.tools.split(",").map(tool => tool.trim()).filter(Boolean);
	if (tools.some(tool => ["write", "edit", "bash"].includes(tool))) {
		throw Object.assign(new Error("Flow start refused: scout persona must expose read-only tools."), { exitCode: 3 });
	}
}

/** Phases: engineer(request) → agent(scout) */
export async function scoutWorkflow(run: Run, input: { args: string[]; dryRun: boolean; cwd: string }, deps: ScoutWorkflowDeps = {}): Promise<FinishResult> {
	const request = input.args.join(" ").trim();
	if (!request) throw Object.assign(new Error("scout flow requires a question"), { exitCode: 2 });
	const persona = deps.persona ?? resolvePersona("researcher", input.cwd);
	const agent = deps.agent ?? runAgentPhase<ScoutReport>;
	await run.phase({ name: "request", kind: "engineer", owner: "operator", description: "Preserve the exact reconnaissance question the operator needs answered" }, ph => ph.log(request));
	const report = await run.phase({ name: "scout", kind: "agent", owner: "researcher", description: "Locate repository evidence without allowing the scout to modify it" }, async () => {
		if (input.dryRun) {
			const parsed = validateEnvelope<ScoutReport>("scout", JSON.stringify(ENVELOPE_EXAMPLES.scout));
			if (!parsed.ok) throw new Error(parsed.errors.join("; "));
			return parsed.value!;
		}
		return agent({ run, persona, task: request, envelope: "scout", cwd: input.cwd, permissionPolicy: SCOUT_PERMISSION_POLICY });
	});
	run.trace.write("log", { phase: "scout", message: report.summary, findings: report.findings });
	return run.finish({ accepted: true });
}
