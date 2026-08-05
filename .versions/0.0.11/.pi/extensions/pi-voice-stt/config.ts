// Configuration loading and validation for the pi-voice-stt extension.
//
// Resolution order (first hit wins):
//   1. PI_STT_CONFIG     — inline JSON (starts with "{") or a path to a JSON file
//   2. <cwd>/.ai/stt.json — project-local config (written by guided setup)
//   3. ~/.pi/agent/stt.json — global config
//   4. built-in defaults
//
// Secrets are never stored in the config file: the config names an environment
// variable (apiKeyEnv) and the key is read from the process environment (a
// gitignored .env at the repo root, auto-loaded by the justfile's dotenv-load).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface CaptureConfig {
	ffmpegPath?: string;
	/** ffmpeg -f input format. Defaults per-platform (avfoundation/pulse/dshow). */
	inputFormat?: string;
	/** ffmpeg -i input device. Defaults per-platform. */
	input?: string;
	sampleRate?: number;
	channels?: number;
	/** Hard cap on recording length. Azure REST short-audio rejects >60s. */
	maxSeconds?: number;
	/** Reject recordings whose WAV is smaller than this (treat as "no audio"). */
	minBytes?: number;
}

export interface OpenAIProvider {
	type: "openai" | "openai-compatible";
	/** Any OpenAI-compatible base, e.g. http://127.0.0.1:8080/v1 for local whisper. */
	baseUrl?: string;
	model?: string;
	apiKeyEnv?: string;
}

export interface AzureProvider {
	type: "azure";
	/** Resource endpoint, e.g. https://<resource>.cognitiveservices.azure.com */
	endpoint?: string;
	/** Env var to read the endpoint from when `endpoint` is unset. */
	endpointEnv?: string;
	apiKeyEnv?: string;
	format?: "simple" | "detailed";
	/**
	 * Candidate locales for the Fast Transcription API's per-phrase language
	 * identification, e.g. ["bg-BG", "en-US"]. When set, the provider uses the
	 * Fast Transcription endpoint instead of the single-language short-audio REST.
	 * Note: identification is phrase-level, not word-level.
	 */
	locales?: string[];
	/** Fast Transcription API version (only used when `locales` is set). */
	apiVersion?: string;
}

export interface AzureOpenAIProvider {
	type: "azure-openai";
	/** Resource endpoint, e.g. https://<resource>.services.ai.azure.com (Azure AI Foundry)
	 * or https://<resource>.openai.azure.com (Azure OpenAI). */
	endpoint?: string;
	/** Env var to read the endpoint from when `endpoint` is unset (default AZURE_OPENAI_ENDPOINT). */
	endpointEnv?: string;
	/** Whisper deployment name as configured in Azure AI Foundry / Azure OpenAI. */
	deployment: string;
	/** Azure OpenAI data-plane API version. */
	apiVersion?: string;
	apiKeyEnv?: string;
	/** Optional; the deployment already pins the model, so usually omitted. */
	model?: string;
}

export type Provider = OpenAIProvider | AzureProvider | AzureOpenAIProvider;

export interface SttConfig {
	keybind: string;
	language: string;
	capture: CaptureConfig;
	provider?: Provider;
}

export interface LoadedConfig {
	config: SttConfig;
	/** Human-readable description of where the config came from. */
	source: string;
}

const DEFAULTS: SttConfig = {
	keybind: "alt+s",
	language: "en-US",
	capture: {
		sampleRate: 16000,
		channels: 1,
		maxSeconds: 60,
		minBytes: 2048,
	},
};

function readConfigFile(): { raw: unknown; source: string } | undefined {
	const fromEnv = process.env.PI_STT_CONFIG?.trim();
	if (fromEnv) {
		if (fromEnv.startsWith("{")) {
			return { raw: JSON.parse(fromEnv), source: "PI_STT_CONFIG (inline)" };
		}
		const resolved = path.resolve(fromEnv);
		return { raw: JSON.parse(readFileSync(resolved, "utf8")), source: resolved };
	}

	// Project-local config in the target repo's .ai/ dir takes precedence over the
	// global one, so a per-project STT setup wins when pi runs inside that repo.
	const candidates = [
		path.resolve(process.cwd(), ".ai", "stt.json"),
		path.join(homedir(), ".pi", "agent", "stt.json"),
	];
	for (const file of candidates) {
		try {
			return { raw: JSON.parse(readFileSync(file, "utf8")), source: file };
		} catch {
			// not present / unreadable — try the next candidate
		}
	}
	return undefined;
}

/** Drop the documentation-only `_azureExample` block and other `_`-prefixed keys. */
function stripComments(obj: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (!k.startsWith("_")) out[k] = v;
	}
	return out;
}

export function loadConfig(): LoadedConfig {
	const file = readConfigFile();
	const fromFile = file && typeof file.raw === "object" && file.raw
		? stripComments(file.raw as Record<string, unknown>)
		: {};

	const config: SttConfig = {
		keybind: (process.env.PI_STT_KEYBIND?.trim() || (fromFile.keybind as string) || DEFAULTS.keybind),
		language: ((fromFile.language as string) || DEFAULTS.language),
		capture: { ...DEFAULTS.capture, ...(fromFile.capture as CaptureConfig | undefined) },
		provider: fromFile.provider as Provider | undefined,
	};

	return { config, source: file?.source ?? "defaults (no config file)" };
}

/** The env var that holds the API key for a provider, with sensible defaults. */
export function apiKeyEnvName(provider: Provider): string {
	if (provider.apiKeyEnv) return provider.apiKeyEnv;
	switch (provider.type) {
		case "azure":
			return "AZURE_SPEECH_KEY";
		case "azure-openai":
			return "AZURE_OPENAI_API_KEY";
		default:
			return "OPENAI_API_KEY";
	}
}

export function resolveApiKey(provider: Provider): string | undefined {
	const value = process.env[apiKeyEnvName(provider)]?.trim();
	return value || undefined;
}

/** Resolve an Azure resource endpoint (Speech or OpenAI) from config or environment. */
export function resolveAzureEndpoint(provider: AzureProvider | AzureOpenAIProvider): string | undefined {
	if (provider.endpoint?.trim()) return provider.endpoint.trim();
	const fallbackEnv = provider.type === "azure-openai" ? "AZURE_OPENAI_ENDPOINT" : "AZURE_SPEECH_ENDPOINT";
	const envName = provider.endpointEnv?.trim() || fallbackEnv;
	return process.env[envName]?.trim() || undefined;
}

/** True when a provider is present AND its API key is available in the environment. */
export function isConfigured(config: SttConfig): boolean {
	const provider = config.provider;
	if (!provider) return false;
	if (!resolveApiKey(provider)) return false;
	if (provider.type === "azure" && !resolveAzureEndpoint(provider)) return false;
	if (provider.type === "azure-openai" && (!resolveAzureEndpoint(provider) || !provider.deployment)) return false;
	return true;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * HTTPS-by-default endpoint policy: plain HTTP is allowed only for loopback hosts
 * (local whisper servers). Throws on any other insecure URL.
 */
export function assertSafeUrl(url: string): URL {
	const parsed = new URL(url);
	if (parsed.protocol === "https:") return parsed;
	if (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname)) return parsed;
	throw new Error(`Insecure endpoint not allowed (use HTTPS, or loopback for local servers): ${url}`);
}
