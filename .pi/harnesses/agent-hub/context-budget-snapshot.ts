import { component, reconcilePlane, safeSchemaChars, type ContextBudgetComponent, type ContextPlane } from "../lib/context-budget.ts";

export interface Usage { input?: number; cacheRead?: number; cacheWrite?: number; output?: number; reasoning?: number; total?: number; cost?: number; }
export interface ProjectionPart { id: string; category: ContextBudgetComponent["category"]; label: string; chars: number; }
export interface LivePlane { id: string; label: string; plane: Exclude<ContextPlane, "hub">; model?: string; window?: number; tokens?: number; percent?: number | null; projectionChars?: number; projectionParts?: readonly ProjectionPart[]; attribution?: "unavailable" | "projected"; }
export interface SnapshotInput {
	model?: string; window?: number; usage?: Usage; systemPrompt?: string; systemPromptOptions?: Record<string, unknown>;
	tools?: readonly { name: string; description?: string; parameters?: unknown; promptGuidelines?: string; sourceInfo?: { source?: string; path?: string; origin?: string } }[];
	activeToolNames?: readonly string[];
	commands?: readonly { name: string; description?: string; source?: string; sourceInfo?: { path?: string; source?: string } }[];
	conversation?: readonly unknown[]; ledger?: readonly ContextBudgetComponent[]; planes?: readonly LivePlane[];
}
export interface ContextBudgetSnapshot { estimator: "chars/4-v1"; capturedAt: number; model?: string; hub: ReturnType<typeof reconcilePlane>; components: ContextBudgetComponent[]; planes: ReturnType<typeof reconcilePlane>[]; usage: Usage; }

const chars = (value: unknown) => typeof value === "string" ? value.length : safeSchemaChars(value);
const entry = (id: string, category: ContextBudgetComponent["category"], label: string, size: number, visibility: ContextBudgetComponent["visibility"] = "model-visible", source?: string) => component({ id, plane: "hub", category, label, source, persistence: "turn", visibility, confidence: "heuristic", chars: size });
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

function textChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (Array.isArray(content)) return content.reduce((sum, part) => sum + (typeof part === "string" ? part.length : typeof part === "object" && part && typeof (part as any).text === "string" ? (part as any).text.length : 0), 0);
	return 0;
}
function conversationEntry(entryValue: unknown): { kind?: string; chars: number; usage?: Usage } | undefined {
	const e = entryValue as any;
	if (!e || typeof e !== "object") return undefined;
	if (e.type === "compaction" || e.type === "branch_summary") return { kind: e.type, chars: chars(e.summary), usage: usageFrom(e.usage) };
	if (e.type === "custom_message") return { kind: "custom", chars: textChars(e.content) };
	if (e.type !== "message") return undefined; // custom, label, session/model/thinking changes are not model messages.
	const message = e.message ?? {};
	return { kind: message.role ?? "message", chars: textChars(message.content), usage: usageFrom(message.usage) };
}
function usageFrom(value: unknown): Usage | undefined {
	if (!value || typeof value !== "object") return undefined;
	const u = value as Record<string, unknown>;
	const result: Usage = { input: number(u.input), cacheRead: number(u.cacheRead), cacheWrite: number(u.cacheWrite), output: number(u.output), reasoning: number(u.reasoning), cost: number(u.cost), total: number(u.totalTokens) ?? number(u.total) };
	return Object.values(result).some(v => v !== undefined) ? result : undefined;
}
function latestUsage(entries: readonly unknown[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) { const found = conversationEntry(entries[i])?.usage; if (found) return found; }
	return undefined;
}

/** Metadata-only snapshot: strings are sized immediately and never returned. */
export function buildContextBudgetSnapshot(input: SnapshotInput): ContextBudgetSnapshot {
	const components: ContextBudgetComponent[] = [...(input.ledger ?? [])];
	if (input.systemPrompt !== undefined && components.length === 0) components.push(entry("hub/final-prompt", "system", "Final Hub system prompt", chars(input.systemPrompt)));
	for (const [key, value] of Object.entries(input.systemPromptOptions ?? {})) {
		if (key === "skills" && Array.isArray(value)) for (const skill of value) { const name = typeof skill === "string" ? skill : String((skill as any)?.name ?? "skill"); components.push(entry(`skill/${name}`, "skill", `Skill: ${name}`, chars(skill), "loaded-excluded", name)); }
		else if ((key === "contextFiles" || key === "promptGuidelines" || key === "toolSnippets") && Array.isArray(value)) {
			for (const item of value) {
				const rec = item as { path?: string; name?: string; content?: string; text?: string } | string;
				const name = typeof rec === "string" ? rec : String(rec.path ?? rec.name ?? key);
				const body = typeof rec === "string" ? rec : rec.content ?? rec.text ?? rec;
				components.push(entry(`pi/${key}/${name}`, "project", `Pi input: ${key} ${name}`, chars(body), "loaded-excluded", name));
			}
		} else if (typeof value === "string" && value) components.push(entry(`pi/${key}`, "project", `Pi input: ${key}`, value.length, "loaded-excluded", key));
	}
	const active = new Set(input.activeToolNames ?? input.tools?.map(tool => tool.name) ?? []);
	for (const tool of input.tools ?? []) if (active.has(tool.name)) components.push(entry(`tool/${tool.name}`, "tool", tool.name, chars({ name: tool.name, description: tool.description, parameters: tool.parameters, promptGuidelines: tool.promptGuidelines }), "model-visible", tool.sourceInfo?.path ?? tool.sourceInfo?.source ?? tool.sourceInfo?.origin));
	for (const command of input.commands ?? []) components.push(entry(`addon/command/${command.name}`, "addon", command.name, chars({ name: command.name, description: command.description }), "ui-only", command.sourceInfo?.path ?? command.sourceInfo?.source ?? command.source));
	const byKind = new Map<string, number>();
	for (const value of input.conversation ?? []) { const e = conversationEntry(value); if (e) byKind.set(e.kind ?? "message", (byKind.get(e.kind ?? "message") ?? 0) + e.chars); }
	for (const [kind, count] of byKind) components.push(entry(`conversation/${kind}`, "conversation", `Conversation: ${kind}`, count));
	const usage = { ...(latestUsage(input.conversation ?? []) ?? {}), ...(input.usage ?? {}) };
	const measured = input.usage?.input ?? input.usage?.total;
	const hub = reconcilePlane(components, "hub", measured, input.window);
	const planes = (input.planes ?? []).map(plane => {
		const projected = plane.projectionParts?.map(part => component({ id: `${plane.id}/${part.id}`, plane: plane.plane, category: part.category, label: part.label, persistence: "projected", visibility: "model-visible", confidence: "heuristic", chars: part.chars })) ?? [component({ id: `${plane.id}/projection`, plane: plane.plane, category: "persona", label: `${plane.label} cold-start projection`, persistence: "projected", visibility: "model-visible", confidence: plane.attribution === "unavailable" ? "unavailable" : "heuristic", chars: plane.projectionChars ?? 0 })];
		const result = reconcilePlane(projected, plane.plane, plane.tokens, plane.window);
		// Pi may report percentage while absolute token count is unavailable. Preserve it without inventing a denominator.
		if (plane.tokens === undefined && number(plane.percent) !== undefined) result.summary.occupancyPercent = number(plane.percent);
		return result;
	});
	return { estimator: "chars/4-v1", capturedAt: Date.now(), model: input.model, hub, components: [...hub.components, ...(hub.residual ? [hub.residual] : [])], planes, usage };
}

/** Pull only Pi's documented read APIs; no send/compact/session write is used here. */
export function collectContextBudgetSnapshot(ctx: any, input: Omit<SnapshotInput, "usage" | "systemPrompt" | "systemPromptOptions" | "tools" | "activeToolNames" | "commands" | "conversation" | "window" | "model"> = {}): ContextBudgetSnapshot {
	const read = <T>(fn: (() => T) | undefined, fallback: T): T => { try { return fn ? fn() : fallback; } catch { return fallback; } };
	const contextUsage = read(ctx?.getContextUsage?.bind(ctx), undefined as { tokens?: number | null; contextWindow?: number; percent?: number | null } | undefined);
	// Pi compaction keeps raw session history for persistence, while buildContextEntries
	// is the branch actually supplied to the next model request. Always prefer it.
	const rawEntries = read(ctx?.sessionManager?.buildContextEntries?.bind(ctx.sessionManager), undefined as unknown);
	const entries = Array.isArray(rawEntries)
		? rawEntries
		: Array.isArray((rawEntries as any)?.entries)
			? (rawEntries as any).entries
			: read(ctx?.sessionManager?.getEntries?.bind(ctx.sessionManager), [] as unknown[]);
	const measured = contextUsage?.tokens == null ? undefined : contextUsage.tokens;
	return buildContextBudgetSnapshot({
		...input,
		model: ctx?.model?.id ?? ctx?.model?.modelId,
		window: contextUsage?.contextWindow ?? input.window ?? ctx?.model?.contextWindow,
		usage: measured === undefined ? input.usage : { total: measured, ...input.usage },
		systemPrompt: input.systemPrompt ?? read(ctx?.getSystemPrompt?.bind(ctx), undefined as string | undefined),
		systemPromptOptions: input.systemPromptOptions ?? read(ctx?.getSystemPromptOptions?.bind(ctx), {} as Record<string, unknown>),
		tools: input.tools ?? [],
		activeToolNames: input.activeToolNames ?? [],
		commands: input.commands ?? [],
		conversation: input.conversation ?? entries,
	});
}
