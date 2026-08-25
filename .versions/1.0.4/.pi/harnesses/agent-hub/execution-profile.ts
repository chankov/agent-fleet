import { orchestratorNeedsRoster } from "./helpers.ts";
import { parsePosture, POSTURES, type Posture } from "./posture.ts";

export type WorkModeParse =
	| { ok: true; action: "picker" }
	| { ok: true; action: "apply"; posture: Posture; deprecatedFrom?: string }
	| { ok: false; error: string };

function titleCase(value: string): string {
	const trimmed = String(value ?? "").trim();
	if (!trimmed) return "";
	return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

function formatPickerOption(selected: boolean, label: string, description: string): string {
	return `${selected ? "✓ " : "  "}${label} — ${description}`;
}

const DEPRECATED_WORK_MODE: Record<string, Posture> = {
	fast: "operator",
	standard: "orchestrator",
	strict: "orchestrator",
};

export function compactPosture(posture: string): string {
	return titleCase(posture) || "Posture";
}

export function parseWorkModeArgs(args: string | undefined | null): WorkModeParse {
	const tokens = String(args ?? "").trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { ok: true, action: "picker" };
	if (tokens.length === 1) {
		const token = tokens[0].toLowerCase();
		const posture = parsePosture(token);
		if (posture) return { ok: true, action: "apply", posture };
		const mapped = DEPRECATED_WORK_MODE[token];
		if (mapped) return { ok: true, action: "apply", posture: mapped, deprecatedFrom: token };
		return {
			ok: false,
			error: `Unknown work mode "${tokens[0]}" — expected operator or orchestrator.`,
		};
	}
	return {
		ok: false,
		error: `Unknown work mode "${tokens.join(" ")}" — expected operator or orchestrator.`,
	};
}

export function posturePickerOptions(current: Posture): { title: string; options: string[]; postures: Posture[] } {
	const postures = [...POSTURES];
	const options = postures.map(posture => formatPickerOption(
		posture === current,
		posture,
		posture === "operator" ? "Direct tools enabled" : "Delegate-only; requires a native roster",
	));
	return { title: `Fleet posture — Alt+M · current ${current}`, options, postures };
}

export function executionPairBlockedByRoster(current: Posture, next: Posture, rosterSize: number): boolean {
	if (next === current) return false;
	return orchestratorNeedsRoster(next, rosterSize);
}

export function selectedPickerValue<T>(options: readonly string[], choice: string | undefined, values: readonly T[]): T | undefined {
	if (choice === undefined) return undefined;
	const index = options.indexOf(choice);
	if (index < 0) return undefined;
	return values[index];
}
