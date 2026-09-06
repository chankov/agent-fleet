import { activityDots, eventCount } from "./activity-dots.ts";

function visibleWidth(text: string): number {
	return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function truncateToWidth(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	let out = text;
	while (out && visibleWidth(out) > width) out = out.slice(0, -1);
	return out;
}

export interface RunningStripItem {
	name: string;
	model: string;
	elapsedMs: number;
	eventCount: number;
}

export interface StripSpecialistInput {
	name: string;
	status: string;
	model: string;
	elapsed: number;
	toolCount: number;
	messageCount: number;
	delegations?: readonly StripDelegateInput[];
}

export interface StripDelegateInput {
	role: string;
	id: string;
	status: string;
	model: string;
	elapsed: number;
	startedAt: number;
	toolCount: number;
	messageCount: number;
}

export interface StripResearchInput {
	id: number;
	persona: boolean;
	displayName: string;
	status: string;
	model: string;
	elapsed: number;
	toolCount: number;
	messageCount: number;
}

export interface StripComsInput {
	name: string;
	model: string;
	elapsed: number;
	eventCount: number;
	running: boolean;
}

const NAME_CAP = 24;

export function collectRunningStripItems(input: {
	specialists: readonly StripSpecialistInput[];
	research: readonly StripResearchInput[];
	coms: readonly StripComsInput[];
}, now = Date.now()): RunningStripItem[] {
	const items: RunningStripItem[] = [];
	for (const spec of input.specialists) {
		if (spec.status === "running") {
			items.push({
				name: spec.name,
				model: spec.model,
				elapsedMs: spec.elapsed,
				eventCount: eventCount(spec.toolCount, spec.messageCount),
			});
		}
		for (const child of spec.delegations ?? []) {
			if (child.status !== "running") continue;
			items.push({
				name: `${spec.name}/${child.role || child.id}`,
				model: child.model,
				elapsedMs: child.status === "running" ? Math.max(0, now - child.startedAt) : child.elapsed,
				eventCount: eventCount(child.toolCount, child.messageCount),
			});
		}
	}
	for (const research of input.research) {
		if (research.status !== "running") continue;
		items.push({
			name: `r${research.id} ${research.persona ? research.displayName : "research"}`,
			model: research.model,
			elapsedMs: research.elapsed,
			eventCount: eventCount(research.toolCount, research.messageCount),
		});
	}
	for (const peer of input.coms) {
		if (!peer.running) continue;
		items.push({
			name: `${peer.name} (coms)`,
			model: peer.model,
			elapsedMs: peer.elapsed,
			eventCount: peer.eventCount,
		});
	}
	return items;
}

export function renderRunningStripLine(
	item: RunningStripItem,
	nameWidth: number,
	width: number,
	theme: { fg(color: string, text: string): string; bold?(text: string): string },
): string {
	const vis = visibleWidth(item.name);
	const name = vis >= nameWidth ? item.name : item.name + " ".repeat(nameWidth - vis);
	const boldName = theme.bold ? theme.bold(name) : name;
	const secs = `${Math.round(item.elapsedMs / 1000)}s`;
	const dots = activityDots(item.eventCount);
	const line = " "
		+ theme.fg("accent", boldName)
		+ "  "
		+ theme.fg("dim", item.model)
		+ "  "
		+ theme.fg("accent", secs)
		+ (dots ? " " + theme.fg("dim", dots) : "");
	return truncateToWidth(line, width);
}

export function renderRunningStrip(
	items: readonly RunningStripItem[],
	width: number,
	theme: { fg(color: string, text: string): string; bold?(text: string): string },
): string[] {
	if (items.length === 0) return [];
	const nameWidth = Math.min(NAME_CAP, Math.max(...items.map(item => visibleWidth(item.name))));
	return items.map(item => renderRunningStripLine(item, nameWidth, width, theme));
}
