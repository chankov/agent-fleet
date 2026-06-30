// ffmpeg-based microphone recorder. Records to a temporary 16 kHz mono PCM WAV,
// which is the format Azure's REST short-audio API requires and the OpenAI path
// accepts unchanged. No native dependencies — just spawns the `ffmpeg` binary.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CaptureConfig } from "./config.js";

interface PlatformDefaults {
	inputFormat: string;
	input: string;
}

function platformDefaults(): PlatformDefaults {
	switch (process.platform) {
		case "darwin":
			return { inputFormat: "avfoundation", input: ":0" };
		case "win32":
			return { inputFormat: "dshow", input: "audio=Microphone" };
		default:
			return { inputFormat: "pulse", input: "default" };
	}
}

export class Recorder {
	private proc: ChildProcess | undefined;
	private dir: string | undefined;
	private wavPath: string | undefined;
	private stderr = "";
	private autoStop: NodeJS.Timeout | undefined;
	private exited: Promise<void> | undefined;

	constructor(private readonly capture: CaptureConfig) {}

	get active(): boolean {
		return this.proc !== undefined;
	}

	/** Spawn ffmpeg. Throws synchronously if the binary cannot be launched. */
	start(): void {
		if (this.proc) throw new Error("Recorder already active");

		const defaults = platformDefaults();
		const inputFormat = this.capture.inputFormat ?? defaults.inputFormat;
		const input = this.capture.input ?? defaults.input;
		const sampleRate = this.capture.sampleRate ?? 16000;
		const channels = this.capture.channels ?? 1;
		const maxSeconds = this.capture.maxSeconds ?? 60;
		const bin = this.capture.ffmpegPath ?? "ffmpeg";

		this.dir = mkdtempSync(path.join(tmpdir(), "pi-stt-"));
		this.wavPath = path.join(this.dir, "capture.wav");

		const args = [
			"-hide_banner",
			"-loglevel", "error",
			"-y",
			"-f", inputFormat,
			"-i", input,
			"-ar", String(sampleRate),
			"-ac", String(channels),
			"-acodec", "pcm_s16le",
			"-t", String(maxSeconds),
			"-f", "wav",
			this.wavPath,
		];

		const proc = spawn(bin, args, { stdio: ["pipe", "ignore", "pipe"] });
		this.proc = proc;
		this.stderr = "";
		proc.stderr?.on("data", (chunk: Buffer) => {
			this.stderr += chunk.toString();
		});

		this.exited = new Promise<void>((resolve) => {
			proc.once("close", () => resolve());
			proc.once("error", (err) => {
				this.stderr += `\n${err instanceof Error ? err.message : String(err)}`;
				resolve();
			});
		});

		// Hard stop slightly after ffmpeg's own -t cap, in case it overruns.
		this.autoStop = setTimeout(() => {
			void this.stop().catch(() => undefined);
		}, (maxSeconds + 2) * 1000);
		this.autoStop.unref?.();
	}

	/**
	 * Stop recording, finalize the WAV, and return its path. Throws if the
	 * capture produced no usable audio or ffmpeg failed.
	 */
	async stop(): Promise<string> {
		const proc = this.proc;
		const wavPath = this.wavPath;
		if (!proc || !wavPath) throw new Error("Recorder is not active");
		this.clearTimer();

		// `q` tells ffmpeg to stop cleanly and flush the file footer.
		try {
			proc.stdin?.write("q");
			proc.stdin?.end();
		} catch {
			proc.kill("SIGINT");
		}

		const killTimer = setTimeout(() => proc.kill("SIGKILL"), 4000);
		killTimer.unref?.();
		await this.exited;
		clearTimeout(killTimer);
		this.proc = undefined;

		const minBytes = this.capture.minBytes ?? 2048;
		let size = 0;
		try {
			size = statSync(wavPath).size;
		} catch {
			this.cleanupDir();
			throw new Error(`No audio captured.${this.stderr ? `\n${this.stderr.trim()}` : ""}`);
		}
		if (size < minBytes) {
			this.cleanupDir();
			throw new Error("Recording too short — no speech captured.");
		}
		return wavPath;
	}

	/** Abort recording and delete the temp file without transcribing. */
	cancel(): void {
		this.clearTimer();
		this.proc?.kill("SIGKILL");
		this.proc = undefined;
		this.cleanupDir();
	}

	/** Remove the temp WAV and its directory. Safe to call repeatedly. */
	cleanup(): void {
		this.cleanupDir();
	}

	private clearTimer(): void {
		if (this.autoStop) {
			clearTimeout(this.autoStop);
			this.autoStop = undefined;
		}
	}

	private cleanupDir(): void {
		if (this.dir) {
			rmSync(this.dir, { recursive: true, force: true });
			this.dir = undefined;
			this.wavPath = undefined;
		}
	}
}
