import type { FleetRow, ProactiveOwnerView, ProactiveSessionView, StripSummary } from "./fleet-read-model.ts";
import type { ThemeLike } from "./fleet-dashboard-view.ts";

export interface TextMetrics {
	visibleWidth(text: string): number;
	truncateToWidth(text: string, width: number): string;
}
export interface StripWindow {
	rows: readonly FleetRow[];
	offset: number;
	above: number;
	below: number;
	activeAbove: number;
	activeBelow: number;
	ancestorPath: readonly string[];
}
export interface StripViewModel {
	active: boolean;
	interactiveAvailable: boolean;
	selectedKey?: string;
	summary: StripSummary;
	window: StripWindow;
	maxRows: number;
	confirmation?: string;
	/** Already retention-filtered session projection; absent when the review is no longer displayed. */
	proactive?: ProactiveSessionView;
}

export function treePrefix(lastAtDepth: readonly boolean[] | undefined, depth = 0): string {
	if (!lastAtDepth) return "   ".repeat(Math.max(0, depth));
	if (!lastAtDepth.length) return "";
	return lastAtDepth.slice(0, -1).map(last => last ? "   " : "│  ").join("") + (lastAtDepth.at(-1) ? "└─ " : "├─ ");
}

const active = (row: FleetRow) => row.status === "running" || (row.status === "pending" && row.kind !== "peer");

/** A bounded contiguous pre-order viewport; selection and offset are already reconciled. */
export function visibleWindow(rows: readonly FleetRow[], selectedIndex: number, offset: number, bodyRows: number): StripWindow {
	const body = Math.max(0, Math.floor(bodyRows));
	if (!body || !rows.length) return { rows: [], offset: 0, above: 0, below: rows.length, activeAbove: 0, activeBelow: rows.filter(active).length, ancestorPath: [] };
	const selected = Math.max(0, Math.min(rows.length - 1, selectedIndex));
	let start = Math.max(0, Math.min(Math.floor(offset), Math.max(0, rows.length - body)));
	if (selected < start) start = selected;
	else if (selected >= start + body) start = selected - body + 1;
	start = Math.max(0, Math.min(start, Math.max(0, rows.length - body)));
	const slice = rows.slice(start, start + body);
	const byKey = new Map(rows.map(row => [row.key, row]));
	const ancestors: string[] = [];
	let cursor = slice[0];
	const seen = new Set<string>();
	while (cursor?.parentKey && !seen.has(cursor.parentKey)) {
		seen.add(cursor.parentKey);
		const parent = byKey.get(cursor.parentKey);
		if (!parent) break;
		if (rows.indexOf(parent) < start) ancestors.unshift(parent.name);
		cursor = parent;
	}
	const below = Math.max(0, rows.length - start - slice.length);
	return {
		rows: slice, offset: start, above: start, below,
		activeAbove: rows.slice(0, start).filter(active).length,
		activeBelow: rows.slice(start + slice.length).filter(active).length,
		ancestorPath: ancestors,
	};
}

/** Remove hostile terminal controls and force arbitrary source fields onto one line. */
export function safeTerminalText(value: unknown): string {
	return String(value ?? "")
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x1f\x7f-\x9f]+/g, " ")
		.replace(/\s+/g, " ").trim();
}

const duration = (row: FleetRow) => row.timingKind === "unknown" || row.startedAt == null ? "—" : row.elapsed < 60_000 ? `${Math.floor(row.elapsed / 1000)}s` : `${Math.floor(row.elapsed / 60_000)}m${String(Math.floor(row.elapsed / 1000) % 60).padStart(2, "0")}s`;
const glyph = (row: FleetRow) => row.status === "running" ? "●" : row.status === "pending" ? "◦" : row.status === "done" ? "✓" : row.status === "error" ? "✗" : row.status === "stale" ? "○" : "▪";
const ctx = (row: FleetRow) => row.contextPct == null ? "ctx —" : `ctx ${Math.round(row.contextPct)}%`;
function padLeft(value: string, width: number, metrics: TextMetrics): string { return " ".repeat(Math.max(0, width - metrics.visibleWidth(value))) + value; }
function fit(value: string, width: number, metrics: TextMetrics): string { return metrics.truncateToWidth(value, Math.max(0, width)); }

function reviewBadge(review: ProactiveOwnerView | ProactiveSessionView): string {
	const parts = ["Review"];
	if (review.currentViolations) parts.push(`${review.currentViolations} violation${review.currentViolations === 1 ? "" : "s"}`);
	if (review.currentSuspicions) parts.push(`${review.currentSuspicions} suspect${review.currentSuspicions === 1 ? "" : "s"}`);
	if (review.stale) parts.push(`${review.stale} stale`);
	if (review.partial) parts.push(`${review.partial} partial`);
	if (review.evaluating) parts.push(`${review.evaluating} evaluating`);
	if (review.resolved) parts.push(`${review.resolved} resolved`);
	if (review.turns && review.reviewed === review.turns && !review.partial && !review.currentViolations && !review.currentSuspicions) parts.push("checked");
	else if (review.turns && !review.reviewed && !review.partial && !review.evaluating && !review.currentViolations && !review.currentSuspicions) parts.push("skipped");
	return parts.join(" ");
}

function compactReview(review: ProactiveSessionView): string {
	if (review.currentViolations) return `Review ${review.currentViolations} violation${review.currentViolations === 1 ? "" : "s"}`;
	if (review.currentSuspicions) return `Review ${review.currentSuspicions} suspect${review.currentSuspicions === 1 ? "" : "s"}`;
	if (review.stale) return `Review ${review.stale} stale`;
	if (review.partial) return `Review ${review.partial} partial`;
	return reviewBadge(review);
}

export function summaryFields(summary: StripSummary, proactive?: ProactiveSessionView): string[] {
	const fields = [`${summary.running} running`];
	if (proactive) fields.push(reviewBadge(proactive));
	if (summary.system1Evaluating) fields.push(`S1 ${summary.system1Evaluating} evaluating`);
	if (summary.system1Mixed) fields.push("S1 mixed");
	const mode = summary.system1Mode && summary.system1Mode !== "unknown" ? summary.system1Mode : null;
	const lastHasMode = !!mode && !!summary.system1Last?.split(" · ").includes(mode);
	if (mode && !summary.system1Mixed && !lastHasMode) fields.push(mode);
	if (!summary.system1Mixed && summary.system1Last && !summary.system1Evaluating) fields.push(summary.system1Last);
	fields.push(`${summary.peerActive} peer active`);
	const wallPartial = summary.wallKnown < summary.wallTotal ? ` (${summary.wallKnown}/${summary.wallTotal} known)` : "";
	fields.push(`wall ${summary.wallKnown ? Math.floor(summary.wallMs / 1000) + "s" : "—"}${wallPartial}`);
	const contextPartial = summary.contextKnown < summary.contextTotal ? ` (${summary.contextKnown}/${summary.contextTotal} known)` : "";
	fields.push(`ctx max ${summary.contextMax == null ? "—" : Math.round(summary.contextMax) + "%"}${contextPartial}`);
	return fields;
}
export function summaryText(summary: StripSummary, proactive?: ProactiveSessionView): string { return summaryFields(summary, proactive).join(" · "); }

function collapsedSummary(summary: StripSummary, proactive: ProactiveSessionView | undefined, width: number, hint: string, metrics: TextMetrics): string {
	const fields = summaryFields(summary, proactive);
	if (proactive) {
		// Review issues take priority over worker counters on very small terminals.
		const issue = fields[1];
		if (metrics.visibleWidth(`  ${fields[0]} · ${issue}`) > width) {
			if (metrics.visibleWidth(` ${issue}`) > width) return fit(` ${compactReview(proactive)}`, width, metrics);
			fields.splice(0, 1);
		}
	}
	for (let count = fields.length; count > 0; count--) {
		const candidate = `  ${fields.slice(0, count).join(" · ")}${hint}`;
		if (metrics.visibleWidth(candidate) <= width) return candidate;
	}
	return fit(`  ${fields[0] ?? ""}`, width, metrics);
}

/** Pure, display-cell bounded widget rendering. */
export function renderFleetStrip(vm: StripViewModel, width: number, theme: ThemeLike, metrics: TextMetrics): string[] {
	const budget = Math.max(0, Math.floor(vm.maxRows));
	const w = Math.max(0, Math.floor(width));
	const system1Shown = (vm.summary.system1Evaluating ?? 0) > 0 || !!vm.summary.system1Last || vm.summary.system1Mixed === true;
	if (!budget || !w || (!vm.window.rows.length && vm.summary.running + vm.summary.peerActive === 0 && !system1Shown && !vm.proactive)) return [];
	const hint = vm.interactiveAvailable ? " · Alt+I inspect" : "";
	const collapsed = fit(theme.fg("dim", collapsedSummary(vm.summary, vm.proactive, w, hint, metrics)), w, metrics);
	if (!vm.active || budget < 4) return [collapsed].slice(0, budget);
	const body = Math.max(0, budget - 3);
	const windowRows = vm.window.rows.slice(0, body);
	const help = vm.confirmation ?? "j/k select · Alt+I collapse · enter open · x/r confirm · esc back";
	const breadcrumb = vm.window.ancestorPath.length ? ` · ${safeTerminalText(vm.window.ancestorPath.join(" / "))}` : "";
	const above = vm.window.above ? `↑ ${vm.window.above} more · ${vm.window.activeAbove} active${breadcrumb}` : "";
	const below = vm.window.below ? `↓ ${vm.window.below} more · ${vm.window.activeBelow} active` : "";
	const header = vm.proactive ? w < 60 ? compactReview(vm.proactive) : reviewBadge(vm.proactive) : help;
	const guidance = vm.proactive && !above ? help : above;
	const lines = [fit(theme.fg("dim", header), w, metrics), fit(theme.fg("dim", guidance), w, metrics)];
	for (const row of windowRows) {
		const marker = row.key === vm.selectedKey ? "❯" : " ";
		const backend = row.backend === "coms" ? "⇄ " : "";
		const badgeText = row.system1 && row.system1.runToken === row.runToken ? safeTerminalText(row.system1.compact) : "";
		const badge = badgeText ? ` ${theme.fg("warning", badgeText)}` : "";
		const review = vm.proactive && row.kind === "specialist" && row.proactive && row.proactive.runToken === row.runToken ? ` ${theme.fg("warning", reviewBadge(row.proactive))}` : "";
		const identity = `${treePrefix(row.lastAtDepth, row.depth)}${glyph(row)} ${safeTerminalText(row.name)}${review}${badge}`;

		const elapsed = padLeft(duration(row), 6, metrics);
		const system1 = badge ? `  ${safeTerminalText(row.system1?.label ?? "")}` : "";
		let line: string;
		if (w < 80) line = `${marker} ${identity}  ${elapsed}`;
		else if (w < 105) line = `${marker} ${identity}  ${backend}${safeTerminalText(row.model)}  ${ctx(row)}  ${elapsed}${system1}`;
		else line = `${marker} ${identity}  ${backend}${safeTerminalText(row.model)}  ${elapsed}  ${row.toolCount == null ? "—" : row.toolCount} tools  ${ctx(row)}${system1}  ${safeTerminalText(row.lastWork)}`;
		line = fit(line, w, metrics);
		if (row.key === vm.selectedKey && theme.bg) {
			const cells = metrics.visibleWidth(line);
			line = theme.bg("selectedBg", line + " ".repeat(Math.max(0, w - cells)));
		}
		lines.push(line);
	}
	lines.push(fit(theme.fg("dim", below), w, metrics));
	return lines.slice(0, budget);
}
