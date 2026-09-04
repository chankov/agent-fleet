import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export const VOICES_REL = ".pi/agents/voices.yaml";
export const VOICE_NAME = /^[A-Za-z0-9_-]{1,16}$/;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
const THINKING = new Set<string>(THINKING_LEVELS);
const VOICE_KEYS = new Set(["name", "model", "thinking", "integrator"]);
const MIN_VOICES = 2;
const MAX_VOICES = 5;

export interface Voice {
	name: string;
	model: string;
	thinking?: ThinkingLevel;
	integrator?: boolean;
}
export interface VoicesFile { path: string; rel: string; panels: Record<string, Voice[]> }
export class VoicesError extends Error {
	readonly errors: string[];
	readonly exitCode = 2;
	constructor(errors: string[]) {
		super(errors.join("\n"));
		this.errors = errors;
		this.name = "VoicesError";
	}
}

export function voicesPath(cwd = process.cwd()): string {
	return resolve(cwd, VOICES_REL);
}

export function listPanelNames(cwd = process.cwd()): string[] {
	try { return Object.keys(loadVoices(cwd).panels); } catch { return []; }
}

export function resolvePanel(name: string, cwd = process.cwd()): Voice[] {
	const file = loadVoices(cwd);
	const voices = file.panels[name];
	if (!voices) {
		const available = Object.keys(file.panels);
		throw new VoicesError([`${file.rel} panel "${name}" was not found. Available panels: ${available.length ? available.join(", ") : "(none)"}`]);
	}
	return voices;
}

export function integratorVoice(voices: Voice[]): Voice | undefined {
	return voices.find(voice => voice.integrator === true);
}

export function loadVoices(cwd = process.cwd()): VoicesFile {
	const path = voicesPath(cwd);
	if (!existsSync(path)) throw new VoicesError([`${VOICES_REL}: file not found`]);
	let raw: unknown;
	try { raw = parseYaml(readFileSync(path, "utf8")); }
	catch (error) { throw new VoicesError([`${VOICES_REL}: invalid YAML (${error instanceof Error ? error.message : String(error)})`]); }
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new VoicesError([`${VOICES_REL}: file must be a mapping of panel name to voice lists`]);
	const errors: string[] = [];
	const panels: Record<string, Voice[]> = {};
	for (const [panel, value] of Object.entries(raw as Record<string, unknown>)) {
		const voices = validatePanel(panel, value, errors);
		if (voices) panels[panel] = voices;
	}
	if (errors.length) throw new VoicesError(errors);
	return { path, rel: VOICES_REL, panels };
}

function validatePanel(panel: string, value: unknown, errors: string[]): Voice[] | undefined {
	const prefix = `${VOICES_REL} panel "${panel}"`;
	if (!Array.isArray(value)) {
		errors.push(`${prefix}: must be a list of voices`);
		return undefined;
	}
	if (value.length < MIN_VOICES || value.length > MAX_VOICES) {
		errors.push(`${prefix}: has ${value.length} voices; a panel must have between ${MIN_VOICES} and ${MAX_VOICES}`);
	}
	const voices: Voice[] = [];
	const seen = new Set<string>();
	let integrators = 0;
	for (const [index, entry] of value.entries()) {
		const parsed = validateVoice(prefix, index, entry, errors);
		if (parsed.name) {
			if (seen.has(parsed.name)) errors.push(`${prefix}: duplicate voice name "${parsed.name}"`);
			seen.add(parsed.name);
		}
		if (parsed.integrator) integrators++;
		if (parsed.voice) voices.push(parsed.voice);
	}
	if (integrators > 1) errors.push(`${prefix}: has ${integrators} voices with integrator: true; at most one is allowed`);
	return voices;
}

function validateVoice(prefix: string, index: number, entry: unknown, errors: string[]): { voice?: Voice; name?: string; integrator: boolean } {
	const label = `${prefix} voice[${index}]`;
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
		errors.push(`${label}: must be a mapping with name and model`);
		return { integrator: false };
	}
	const raw = entry as Record<string, unknown>;
	for (const key of Object.keys(raw)) {
		if (!VOICE_KEYS.has(key)) errors.push(`${label}: unknown key "${key}"`);
	}
	const name = typeof raw.name === "string" && VOICE_NAME.test(raw.name) ? raw.name : undefined;
	if (!name) errors.push(`${label}: name is required, unique in the panel, and must match ${VOICE_NAME}`);
	const model = raw.model;
	const modelOk = typeof model === "string" && model.includes("/") && !model.startsWith("/") && !model.endsWith("/") && model.split("/").every(part => part);
	if (!modelOk) errors.push(`${label}: model must be fully qualified provider/id (got ${JSON.stringify(raw.model)})`);
	let thinking: ThinkingLevel | undefined;
	if (raw.thinking !== undefined) {
		if (typeof raw.thinking !== "string" || !THINKING.has(raw.thinking)) {
			errors.push(`${label}: thinking must be one of ${[...THINKING_LEVELS].join("|")}`);
		} else thinking = raw.thinking as ThinkingLevel;
	}
	if (raw.integrator !== undefined && typeof raw.integrator !== "boolean") {
		errors.push(`${label}: integrator must be a boolean`);
	}
	const integrator = raw.integrator === true;
	if (!name || !modelOk) return { name, integrator };
	return {
		name, integrator,
		voice: { name, model: model as string, ...(thinking ? { thinking } : {}), ...(integrator ? { integrator: true } : {}) },
	};
}
