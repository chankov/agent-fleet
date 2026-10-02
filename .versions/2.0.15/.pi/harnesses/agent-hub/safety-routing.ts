import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const CONTINUE_ENTRY = /damage-control-continue[/\\]index\.ts$/;
const MISSING_SAFETY_ERROR = "damage-control-continue harness not found — guarded child dispatch refused";

/** Resolve only the surviving continue harness; never downgrade to an unguarded or hard-stop child. */
export function resolveSafetyHarness(cwd: string, argv: string[] = process.argv): string | null {
	for (let i = 0; i < argv.length - 1; i++) {
		if (argv[i] !== "-e" && argv[i] !== "--extension") continue;
		const candidate = resolve(argv[i + 1]);
		if (CONTINUE_ENTRY.test(candidate) && existsSync(candidate)) return candidate;
	}
	const local = join(cwd, ".pi", "harnesses", "damage-control-continue", "index.ts");
	return existsSync(local) ? local : null;
}

export function requireSafetyHarness(path: string | null):
	| { ok: true; extensions: string[] }
	| { ok: false; error: string } {
	return path ? { ok: true, extensions: [path] } : { ok: false, error: MISSING_SAFETY_ERROR };
}
