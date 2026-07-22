// pi-voice-stt — push-to-talk dictation for pi's terminal UI.
//
// Press Alt+S to start recording, Alt+S again to transcribe and insert the text
// into the prompt. While recording, Enter transcribes and sends immediately, and
// Esc cancels. The extension is a silent no-op until a provider is configured —
// see README.md and `/stt doctor`.

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { matchesKey } from "@mariozechner/pi-tui";
import { spawn } from "node:child_process";
import { apiKeyEnvName, isConfigured, loadConfig, resolveAzureEndpoint } from "./config.js";
import { transcribe } from "./providers.js";
import { Recorder } from "./recorder.js";

const STATUS_KEY = "voice-stt";

type State = "idle" | "recording" | "transcribing";

export default function voiceSttExtension(pi: ExtensionAPI): void {
	const { config, source } = loadConfig();

	let state: State = "idle";
	let recorder: Recorder | undefined;
	let recordStart = 0;
	let tick = 0;
	let anim: ReturnType<typeof setInterval> | undefined;
	let unsubInput: (() => void) | undefined;

	// ---- indicator ---------------------------------------------------------

	function renderFrame(): string {
		if (state === "recording") {
			const secs = Math.max(0, Math.floor((Date.now() - recordStart) / 1000));
			const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
			const dot = tick % 2 === 0 ? "●" : "○";
			return `${dot} REC ${clock}  ⏎ send · esc cancel`;
		}
		const frames = ["·  ", " · ", "  ·", " · "];
		return `${frames[tick % frames.length]} transcribing…`;
	}

	function startAnim(ctx: ExtensionContext): void {
		stopAnimTimer();
		anim = setInterval(() => {
			tick++;
			ctx.ui.setStatus(STATUS_KEY, renderFrame());
		}, 120);
		anim.unref?.();
		ctx.ui.setStatus(STATUS_KEY, renderFrame());
	}

	function stopAnimTimer(): void {
		if (anim) {
			clearInterval(anim);
			anim = undefined;
		}
	}

	function reset(ctx: ExtensionContext): void {
		state = "idle";
		stopAnimTimer();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	// ---- state machine -----------------------------------------------------

	function startRecording(ctx: ExtensionContext): void {
		if (state !== "idle") return;
		if (!isConfigured(config)) {
			ctx.ui.notify("Voice STT is not configured — run /stt doctor for setup help.", "warning");
			return;
		}

		recorder = new Recorder(config.capture);
		try {
			recorder.start();
		} catch (error) {
			recorder = undefined;
			ctx.ui.notify(`Could not start ffmpeg: ${describe(error)}`, "error");
			return;
		}

		state = "recording";
		recordStart = Date.now();
		startAnim(ctx);

		// While recording, intercept Enter (send) and Esc (cancel); let other keys through.
		unsubInput = ctx.ui.onTerminalInput((data) => {
			if (state !== "recording") return undefined;
			if (matchesKey(data, "enter")) {
				void finish(ctx, true);
				return { consume: true };
			}
			if (matchesKey(data, "escape")) {
				cancel(ctx);
				return { consume: true };
			}
			return undefined;
		});
	}

	async function finish(ctx: ExtensionContext, send: boolean): Promise<void> {
		if (state !== "recording" || !recorder) return;
		const active = recorder;
		state = "transcribing";
		unsubInput?.();
		unsubInput = undefined;
		startAnim(ctx);

		try {
			const wavPath = await active.stop();
			const text = await transcribe(wavPath, config);
			active.cleanup();

			if (send) {
				const existing = ctx.ui.getEditorText().trim();
				const content = existing ? `${existing} ${text}` : text;
				ctx.ui.setEditorText("");
				pi.sendUserMessage(content);
			} else {
				const current = ctx.ui.getEditorText();
				const sep = current.length > 0 && !/\s$/.test(current) ? " " : "";
				ctx.ui.setEditorText(`${current}${sep}${text}`);
			}
		} catch (error) {
			active.cleanup();
			ctx.ui.notify(`Voice STT: ${describe(error)}`, "error");
		} finally {
			recorder = undefined;
			reset(ctx);
		}
	}

	function cancel(ctx: ExtensionContext): void {
		unsubInput?.();
		unsubInput = undefined;
		recorder?.cancel();
		recorder = undefined;
		reset(ctx);
		ctx.ui.notify("Voice capture cancelled.", "info");
	}

	// ---- commands ----------------------------------------------------------

	pi.registerCommand("stt", {
		description: "Voice dictation: status | doctor | start | stop | send | cancel",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const sub = args.trim().split(/\s+/)[0]?.toLowerCase() || "status";
			switch (sub) {
				case "status":
					ctx.ui.notify(statusLine(), "info");
					return;
				case "doctor":
					await runDoctor(ctx);
					return;
				case "start":
					startRecording(ctx);
					return;
				case "stop":
					await finish(ctx, false);
					return;
				case "send":
					await finish(ctx, true);
					return;
				case "cancel":
					if (state === "idle") ctx.ui.notify("Nothing to cancel.", "info");
					else cancel(ctx);
					return;
				default:
					ctx.ui.notify(`Unknown /stt subcommand: ${sub}`, "warning");
			}
		},
	});

	// Only bind the hotkey once a provider is configured — keeps the extension a
	// true no-op for users who haven't set it up.
	if (isConfigured(config)) {
		pi.registerShortcut(config.keybind, {
			description: "Voice dictation: toggle recording (insert); Enter sends, Esc cancels",
			handler: async (ctx) => {
				if (state === "idle") startRecording(ctx);
				else if (state === "recording") await finish(ctx, false);
				// transcribing: ignore
			},
		});
	}

	pi.on("session_shutdown", async () => {
		stopAnimTimer();
		recorder?.cancel();
		recorder = undefined;
		unsubInput?.();
		unsubInput = undefined;
	});

	// ---- helpers -----------------------------------------------------------

	function statusLine(): string {
		const provider = config.provider ? config.provider.type : "none";
		const ready = isConfigured(config) ? "configured" : "NOT configured";
		return `Voice STT: ${ready} · provider=${provider} · keybind=${config.keybind} · state=${state} · config=${source}`;
	}

	async function runDoctor(ctx: ExtensionCommandContext): Promise<void> {
		const lines: string[] = [];
		const ffmpeg = config.capture.ffmpegPath ?? "ffmpeg";
		lines.push((await hasFfmpeg(ffmpeg)) ? `✓ ffmpeg found (${ffmpeg})` : `✗ ffmpeg not found — install it and ensure it is on PATH`);

		if (!config.provider) {
			lines.push("✗ no provider configured — see .pi/extensions/pi-voice-stt/README.md");
		} else {
			lines.push(`• provider: ${config.provider.type}`);
			const keyEnv = apiKeyEnvName(config.provider);
			lines.push(process.env[keyEnv]?.trim() ? `✓ API key present (${keyEnv})` : `✗ API key missing — set ${keyEnv}`);
			if (config.provider.type === "azure") {
				const ep = resolveAzureEndpoint(config.provider);
				lines.push(ep ? `✓ Azure endpoint: ${ep}` : "✗ Azure endpoint missing — set `endpoint` or AZURE_SPEECH_ENDPOINT");
			}
			if (config.provider.type === "azure-openai") {
				const ep = resolveAzureEndpoint(config.provider);
				lines.push(ep ? `✓ endpoint: ${ep}` : "✗ endpoint missing — set `endpoint` or AZURE_OPENAI_ENDPOINT");
				if (ep && /\.services\.ai\.azure\.com/i.test(ep)) {
					lines.push("⚠ Foundry host does not serve audio — use *.openai.azure.com / *.cognitiveservices.azure.com");
				}
				lines.push(config.provider.deployment ? `✓ deployment: ${config.provider.deployment}` : "✗ deployment missing — set the Whisper deployment name");
				lines.push(`• api-version: ${config.provider.apiVersion ?? "2024-10-21"}`);
			}
		}
		lines.push(`config source: ${source}`);
		ctx.ui.notify(lines.join("\n"), isConfigured(config) ? "info" : "warning");
	}
}

function hasFfmpeg(bin: string): Promise<boolean> {
	return new Promise((resolve) => {
		try {
			const proc = spawn(bin, ["-version"], { stdio: "ignore" });
			proc.once("error", () => resolve(false));
			proc.once("close", (code) => resolve(code === 0));
		} catch {
			resolve(false);
		}
	});
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
