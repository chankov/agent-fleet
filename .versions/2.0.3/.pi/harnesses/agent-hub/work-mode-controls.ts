import { orchestratorNeedsRoster } from "./helpers.ts";
import { parseWorkMode, WORK_MODES, type WorkMode } from "./work-mode.ts";

export type WorkModeParse =
	| { ok: true; action: "picker" }
	| { ok: true; action: "apply"; workMode: WorkMode }
	| { ok: false; error: string };

function titleCase(value: string): string {
	const trimmed = String(value ?? "").trim();
	if (!trimmed) return "";
	return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

function formatPickerOption(selected: boolean, label: string, description: string): string {
	return `${selected ? "✓ " : "  "}${label} — ${description}`;
}

export function compactWorkMode(workMode: string): string {
	return titleCase(workMode) || "Work Mode";
}

export function parseWorkModeArgs(args: string | undefined | null): WorkModeParse {
	const tokens = String(args ?? "").trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { ok: true, action: "picker" };
	if (tokens.length === 1) {
		const workMode = parseWorkMode(tokens[0].toLowerCase());
		if (workMode) return { ok: true, action: "apply", workMode };
	}
	return {
		ok: false,
		error: `Unknown work mode "${tokens.join(" ")}" — expected operator or orchestrator.`,
	};
}

export function workModePickerOptions(current: WorkMode): { title: string; options: string[]; workModes: WorkMode[] } {
	const workModes = [...WORK_MODES];
	const options = workModes.map(workMode => formatPickerOption(
		workMode === current,
		workMode,
		workMode === "operator" ? "Direct tools enabled" : "Delegate-only; requires a native roster",
	));
	return { title: `Fleet Work Mode — Alt+M · current ${current}`, options, workModes };
}

export function workModeChangeBlockedByRoster(current: WorkMode, next: WorkMode, rosterSize: number): boolean {
	if (next === current) return false;
	return orchestratorNeedsRoster(next, rosterSize);
}

export function selectedPickerValue<T>(options: readonly string[], choice: string | undefined, values: readonly T[]): T | undefined {
	if (choice === undefined) return undefined;
	const index = options.indexOf(choice);
	if (index < 0) return undefined;
	return values[index];
}
