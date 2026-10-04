import {
	accessDecisionChoices,
	accessRequestCacheKey,
	appendExemptionToFile,
	fileExemptionsFor,
	type AccessDecision,
	type AccessDecisionChoice,
	type AccessRequest,
} from "../lib/damage-control-shared.ts";

type ApprovalContext = {
	hasUI: boolean;
	ui: {
		notify(message: string, level?: string): void;
		select(title: string, options: string[], settings: { timeout: number }): Promise<string | undefined>;
	};
};

type ReplySocket = {
	write(chunk: string): unknown;
	end(): unknown;
};

type AccessApprovalDeps = {
	getContext(): ApprovalContext | null | undefined;
	getExemptionsFile(): string | null | undefined;
	appendLog(entry: Record<string, unknown>): void;
	now(): string;
};

export function createAccessApprovalRouter(deps: AccessApprovalDeps) {
	let askQueue: Promise<unknown> = Promise.resolve();
	let generation = 0;
	const denyCache = new Set<string>();
	const pending = new Map<string, Promise<AccessDecisionChoice>>();

	const respond = (socket: ReplySocket, msgId: string, decision: AccessDecisionChoice) => {
		const reply: AccessDecision = { type: "access_decision", msg_id: msgId, decision };
		try { socket.write(JSON.stringify(reply) + "\n"); } catch { /* child may have timed out */ }
		try { socket.end(); } catch { /* ignore */ }
	};

	const validRequest = (request: AccessRequest) =>
		typeof request.pattern === "string" && request.pattern.length > 0 &&
		(request.category === "zero_access" || request.category === "read_only" || request.category === "no_delete");

	const decide = (request: AccessRequest): Promise<AccessDecisionChoice> => {
		const agent = (typeof request.agent === "string" && request.agent) || request.sender_session || "unknown-agent";
		const pattern = request.pattern;
		const cacheKey = accessRequestCacheKey({ ...request, agent, pattern });
		const exemptionsFile = deps.getExemptionsFile();
		const requestGeneration = generation;

		if (fileExemptionsFor(exemptionsFile ?? undefined, agent).some((entry) => entry.pattern === pattern)) {
			return Promise.resolve("allow_all");
		}
		if (denyCache.has(cacheKey)) return Promise.resolve("deny");
		const existing = pending.get(cacheKey);
		if (existing) return existing;

		const ask = askQueue.then(async (): Promise<AccessDecisionChoice> => {
			if (requestGeneration !== generation) return "deny";
			const ctx = deps.getContext();
			if (!ctx?.hasUI) return "deny";

			const labels = new Map<AccessDecisionChoice, string>([
				["deny", "Deny (keep blocked)"],
				["allow_once", "Allow once"],
				["allow_agent", `Allow for ${agent} (this session)`],
				["allow_all", "Allow for all agents (this session)"],
			]);
			const allowed = accessDecisionChoices(request.category);
			const options = allowed.map((decision) => labels.get(decision)!);
			ctx.ui.notify(
				`🛡️ Access request from ${agent}: ${request.rule}\n   tool: ${request.tool}\n   attempted: ${String(request.invocation || "").slice(0, 200)}`,
				"warning",
			);
			try {
				const choice = await ctx.ui.select(
					`🛡️ ${agent} requests access: ${pattern}`,
					options,
					{ timeout: 600_000 },
				);
				if (requestGeneration !== generation) return "deny";
				const selected = allowed.find((decision) => labels.get(decision) === choice) ?? "deny";
				if (selected === "deny" && choice === labels.get("deny")) denyCache.add(cacheKey);
				return selected;
			} catch {
				return "deny";
			}
		});

		askQueue = ask.catch(() => {});
		pending.set(cacheKey, ask);
		void ask.finally(() => pending.delete(cacheKey));
		return ask;
	};

	return {
		async handle(socket: ReplySocket, request: AccessRequest): Promise<void> {
			if (!validRequest(request)) {
				respond(socket, request.msg_id, "deny");
				return;
			}
			const agent = (typeof request.agent === "string" && request.agent) || request.sender_session || "unknown-agent";
			const decision = await decide(request).catch((): AccessDecisionChoice => "deny");
			const exemptionsFile = deps.getExemptionsFile();
			if ((decision === "allow_agent" || decision === "allow_all") && exemptionsFile) {
				try {
					appendExemptionToFile(exemptionsFile, {
						pattern: request.pattern,
						scope: "session",
						agent: decision === "allow_agent" ? agent : undefined,
						grantedVia: "escalation",
						grantedAt: deps.now(),
					});
				} catch { /* allow-once semantics still hold via the reply */ }
			}
			deps.appendLog({ action: `escalation_${decision}`, agent, pattern: request.pattern, tool: request.tool, rule: request.rule });
			try {
				deps.getContext()?.ui.notify(
					`🛡️ Access ${decision === "deny" ? "denied" : `granted (${decision.replace(/_/g, " ")})`}: ${request.pattern} — ${agent}`,
					decision === "deny" ? "warning" : "info",
				);
			} catch { /* ignore */ }
			respond(socket, request.msg_id, decision);
		},
		reset() {
			generation++;
			askQueue = Promise.resolve();
			denyCache.clear();
			pending.clear();
		},
	};
}
