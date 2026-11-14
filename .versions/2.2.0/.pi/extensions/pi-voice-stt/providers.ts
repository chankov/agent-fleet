// Speech-to-text providers. Three backends, all file-based (a temp WAV in, text out):
//   - openai:       any OpenAI-compatible /audio/transcriptions endpoint (multipart)
//   - azure:        Azure Speech "REST API for short audio" (raw WAV body, ≤60s)
//   - azure-openai: Whisper hosted on Azure OpenAI / Azure AI Foundry (multipart)
//
// Uses the global fetch / FormData / Blob available in Node >= 18.

import { readFileSync } from "node:fs";
import {
	type AzureOpenAIProvider,
	type AzureProvider,
	type OpenAIProvider,
	type SttConfig,
	apiKeyEnvName,
	assertSafeUrl,
	resolveApiKey,
	resolveAzureEndpoint,
} from "./config.js";

function trimSlash(s: string): string {
	return s.replace(/\/+$/, "");
}

// Shared multipart /audio/transcriptions POST used by every Whisper-style backend.
// The only differences between OpenAI and Azure OpenAI are the URL and the auth
// header, so both are passed in.
// Retry transient failures: rate limits (429), server errors (5xx), and Azure's
// *transient* DeploymentNotFound (404) that a freshly-created / propagating Azure
// OpenAI deployment returns intermittently. Other 4xx (e.g. 401) fail immediately.
function isTransientStatus(status: number, body: string): boolean {
	if (status === 429 || status >= 500) return true;
	if (status === 404 && /DeploymentNotFound/i.test(body)) return true;
	return false;
}

const RETRY_ATTEMPTS = 3;

async function postTranscription(
	url: string,
	authHeaders: Record<string, string>,
	wavPath: string,
	language: string,
	model: string | undefined,
	label: string,
): Promise<string> {
	const bytes = new Uint8Array(readFileSync(wavPath));

	for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
		const form = new FormData();
		form.append("file", new Blob([bytes], { type: "audio/wav" }), "audio.wav");
		if (model) form.append("model", model);
		// Whisper expects an ISO-639-1 code ("en"/"bg"), not a locale ("en-US").
		if (language) form.append("language", language.split("-")[0]);

		const res = await fetch(url, { method: "POST", headers: authHeaders, body: form });
		if (res.ok) {
			const json = (await res.json()) as { text?: string };
			const text = json.text?.trim();
			if (!text) throw new Error(`${label} returned no text.`);
			return text;
		}

		const body = (await res.text()).slice(0, 500);
		if (attempt === RETRY_ATTEMPTS || !isTransientStatus(res.status, body)) {
			throw new Error(`${label} failed (${res.status}): ${body}`);
		}
		// Linear backoff between attempts (0.8s, 1.6s).
		await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
	}

	throw new Error(`${label} failed after ${RETRY_ATTEMPTS} attempts.`);
}

async function transcribeOpenAI(wavPath: string, config: SttConfig, provider: OpenAIProvider): Promise<string> {
	const key = resolveApiKey(provider);
	if (!key) throw new Error(`Missing API key — set ${apiKeyEnvName(provider)}.`);

	const baseUrl = trimSlash(provider.baseUrl ?? "https://api.openai.com/v1");
	const url = assertSafeUrl(`${baseUrl}/audio/transcriptions`).toString();
	return postTranscription(url, { Authorization: `Bearer ${key}` }, wavPath, config.language, provider.model ?? "whisper-1", "OpenAI STT");
}

// Whisper deployed on Azure OpenAI / Azure AI Foundry. OpenAI-compatible multipart
// body, but the URL embeds the deployment + api-version and auth uses `api-key`.
async function transcribeAzureOpenAI(wavPath: string, config: SttConfig, provider: AzureOpenAIProvider): Promise<string> {
	const key = resolveApiKey(provider);
	if (!key) throw new Error(`Missing API key — set ${apiKeyEnvName(provider)}.`);
	const endpoint = resolveAzureEndpoint(provider);
	if (!endpoint) throw new Error("Missing Azure endpoint — set `endpoint` or AZURE_OPENAI_ENDPOINT.");
	if (!provider.deployment) throw new Error("Missing Azure OpenAI `deployment` (the Whisper deployment name).");

	const apiVersion = provider.apiVersion ?? "2024-10-21";
	const base = trimSlash(endpoint);
	const url = assertSafeUrl(
		`${base}/openai/deployments/${encodeURIComponent(provider.deployment)}/audio/transcriptions?api-version=${apiVersion}`,
	).toString();
	return postTranscription(url, { "api-key": key }, wavPath, config.language, provider.model, "Azure OpenAI Whisper");
}

interface AzureResponse {
	RecognitionStatus: string;
	DisplayText?: string;
	NBest?: Array<{ Display?: string }>;
}

interface AzureFastResponse {
	combinedPhrases?: Array<{ text?: string }>;
	phrases?: Array<{ text?: string; locale?: string }>;
}

// Fast Transcription API with per-phrase language identification. Posts the WAV
// plus a `definition` with candidate `locales` and returns the combined text.
// Identification is phrase-level, so a single English word inside a Bulgarian
// sentence may still be transliterated.
async function transcribeAzureFast(
	wavPath: string,
	provider: AzureProvider,
	key: string,
	base: string,
): Promise<string> {
	const apiVersion = provider.apiVersion ?? "2024-11-15";
	const url = assertSafeUrl(`${base}/speechtotext/transcriptions:transcribe?api-version=${apiVersion}`).toString();

	const bytes = new Uint8Array(readFileSync(wavPath));
	const form = new FormData();
	form.append("audio", new Blob([bytes], { type: "audio/wav" }), "audio.wav");
	form.append("definition", JSON.stringify({ locales: provider.locales }));

	const res = await fetch(url, {
		method: "POST",
		headers: { "Ocp-Apim-Subscription-Key": key, Accept: "application/json" },
		body: form,
	});
	if (!res.ok) {
		throw new Error(`Azure fast-transcription failed (${res.status}): ${(await res.text()).slice(0, 500)}`);
	}

	const json = (await res.json()) as AzureFastResponse;
	const text = (json.combinedPhrases ?? [])
		.map((p) => p.text?.trim())
		.filter(Boolean)
		.join(" ")
		.trim();
	if (!text) throw new Error("Azure fast-transcription returned no text (no speech detected?).");
	return text;
}

async function transcribeAzure(wavPath: string, config: SttConfig, provider: AzureProvider): Promise<string> {
	const key = resolveApiKey(provider);
	if (!key) throw new Error(`Missing API key — set ${apiKeyEnvName(provider)}.`);
	const endpoint = resolveAzureEndpoint(provider);
	if (!endpoint) throw new Error("Missing Azure endpoint — set `endpoint` or AZURE_SPEECH_ENDPOINT.");
	const base = trimSlash(endpoint);

	// Multiple candidate locales → use Fast Transcription with language identification.
	if (provider.locales && provider.locales.length > 0) {
		return transcribeAzureFast(wavPath, provider, key, base);
	}

	const format = provider.format ?? "detailed";
	const url = assertSafeUrl(
		`${base}/stt/speech/recognition/conversation/cognitiveservices/v1` +
			`?language=${encodeURIComponent(config.language)}&format=${format}`,
	).toString();

	const body = new Uint8Array(readFileSync(wavPath));
	const res = await fetch(url, {
		method: "POST",
		headers: {
			"Ocp-Apim-Subscription-Key": key,
			"Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
			Accept: "application/json",
		},
		body,
	});
	if (!res.ok) {
		throw new Error(`Azure STT failed (${res.status}): ${(await res.text()).slice(0, 500)}`);
	}

	const json = (await res.json()) as AzureResponse;
	switch (json.RecognitionStatus) {
		case "Success":
			break;
		case "NoMatch":
			throw new Error("Azure STT: speech detected but no words matched (check the `language` setting).");
		case "InitialSilenceTimeout":
		case "BabbleTimeout":
			throw new Error("Azure STT: no speech detected in the recording.");
		default:
			throw new Error(`Azure STT error: ${json.RecognitionStatus}`);
	}

	const text = (format === "detailed" ? json.NBest?.[0]?.Display : json.DisplayText)?.trim();
	if (!text) throw new Error("Azure STT returned no text.");
	return text;
}

/** Transcribe a recorded WAV file to text using the configured provider. */
export async function transcribe(wavPath: string, config: SttConfig): Promise<string> {
	const provider = config.provider;
	if (!provider) throw new Error("No STT provider configured.");

	switch (provider.type) {
		case "openai":
		case "openai-compatible":
			return transcribeOpenAI(wavPath, config, provider);
		case "azure":
			return transcribeAzure(wavPath, config, provider);
		case "azure-openai":
			return transcribeAzureOpenAI(wavPath, config, provider);
		default:
			throw new Error(`Unknown provider type: ${(provider as { type: string }).type}`);
	}
}
