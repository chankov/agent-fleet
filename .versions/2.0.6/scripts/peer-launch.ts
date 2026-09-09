// scripts/peer-launch.ts
//
// `just fleet peer <name>` — launch ONE coms peer (pi persona, personaless
// Fleet Core pi, or Claude Code) without declaring it in a peers.yaml team.
//
// Placement:
//   • default, inside a herdr pane (HERDR_ENV=1) → split THIS pane, so the peer
//     lands next to the session that asked for it;
//   • default, outside herdr → create a single-pane workspace labelled
//     <worktree-tag>-peer-<name>, refusing to clobber an existing one;
//   • --here → run in the CALLING terminal, which is what this command did
//     before pane placement existed.
//
// Hard rules (same as team-up.ts, for the same reasons):
// - Entrypoint guard: importing this module must NOT spawn anything.
// - peers.yaml + the repo root resolve relative to THIS file, not the caller's cwd.
// - --dry-run prints the plan and exits WITHOUT touching herdr, and never reads
//   env_file values — secrets stay out of terminals and logs.
// - A split pane gets its argv TYPED at the shell prompt: herdr's pane.split
//   takes no command and silently ignores one (see spawned-peers.js).

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { launchPeerInPane, PANE_PROMPT_TIMEOUT_MS, PEER_READY_TIMEOUT_MS, peerReadyDelayMs } from "../.pi/harnesses/lib/spawned-peers.js";
import { pruneDeadEntries } from "./lib/coms-envelope.ts";
import { parseEnvFile, resolveEnvFilePath, type LayoutNode } from "./lib/herdr-layout.ts";
import { assertClaudeCodeAvailable } from "./claude-code-preflight.ts";
import { buildPeerLaunchPlan, parsePeerArgs, type PeerLaunchPlan } from "./lib/peer-launch.ts";
import { assertRuntimeDependencies } from "./lib/runtime-dependencies.js";
import { worktreeTag } from "./lib/team-project.ts";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = fs.realpathSync(path.resolve(SCRIPT_DIR, ".."));
const PEERS_YAML = path.join(REPO_ROOT, ".pi", "agents", "peers.yaml");

const USAGE =
	"usage: just fleet peer <name> [--runner pi|claude-code] [--persona <p>] [--model <m>] [--project <p>]\n" +
	"                             [--extensions a,b] [--browser] [--all-extensions]\n" +
	"                             [--direction right|down] [--here] [--dry-run] [-- PI_ARGS…]";

function die(msg: string): never {
	console.error(msg);
	process.exit(1);
}

function personaExists(persona: string): boolean {
	return (
		fs.existsSync(path.join(REPO_ROOT, "agents", `${persona}.md`)) ||
		fs.existsSync(path.join(REPO_ROOT, ".pi", "agents", `${persona}.md`))
	);
}

function readIfPresent(file: string): string {
	try {
		return fs.readFileSync(file, "utf-8");
	} catch {
		return "";
	}
}

/** The pane's extra env: only the declaration's env_file, never on the dry-run path. */
function paneEnv(plan: PeerLaunchPlan): Record<string, string> {
	if (!plan.envFile) return {};
	const abs = resolveEnvFilePath(plan.envFile, REPO_ROOT);
	if (!fs.existsSync(abs)) die(`Peer "${plan.name}": env_file not found: ${plan.envFile} (resolved: ${abs})`);
	return parseEnvFile(fs.readFileSync(abs, "utf-8"), plan.envFile);
}

/** Poll the coms registry until the peer registers, or the budget runs out. */
async function waitForRegistration(plan: PeerLaunchPlan): Promise<{ found: boolean; waitedMs: number }> {
	const wanted = plan.name.toLowerCase();
	const started = Date.now();
	for (let attempt = 0; ; attempt++) {
		let live: { name: string }[] = [];
		try {
			live = pruneDeadEntries(plan.project);
		} catch {
			// Registry not readable yet; the timeout below bounds the wait.
		}
		if (live.some((entry) => entry.name.toLowerCase() === wanted)) {
			return { found: true, waitedMs: Date.now() - started };
		}
		const remaining = PEER_READY_TIMEOUT_MS - (Date.now() - started);
		if (remaining <= 0) return { found: false, waitedMs: Date.now() - started };
		await new Promise((r) => setTimeout(r, Math.min(peerReadyDelayMs(attempt), remaining)));
	}
}

async function main(): Promise<void> {
	let args;
	try {
		args = parsePeerArgs(process.argv.slice(2));
	} catch (err) {
		console.error(`fleet peer: ${err instanceof Error ? err.message : String(err)}`);
		console.error(USAGE);
		process.exit(2);
	}

	let plan: PeerLaunchPlan;
	try {
		plan = buildPeerLaunchPlan(args, {
			peersYaml: readIfPresent(args.peersYaml ?? PEERS_YAML),
			personaExists,
			worktreeTag: worktreeTag(REPO_ROOT),
		});
	} catch (err) {
		die(`fleet peer: ${err instanceof Error ? err.message : String(err)}`);
	}

	const inPane = process.env.HERDR_ENV === "1" ? process.env.HERDR_PANE_ID || null : null;

	if (args.dryRun) {
		// No executable probes, herdr calls, or env_file reads on this path.
		const placement =
			plan.placement === "here"
				? "this terminal"
				: inPane
					? `split of pane ${inPane} (${plan.direction})`
					: `new workspace "${plan.workspaceLabel}"`;
		const envNote = plan.envFile ? `  [env_file: ${plan.envFile} — values redacted]` : "";
		const source = plan.declared ? "peers.yaml declaration + flags" : "flags only";
		console.log(`# fleet peer (dry run) — "${plan.name}" [${plan.kind}], project "${plan.project}", ${source}`);
		console.log(`# placement: ${placement}`);
		console.log(`${plan.name}\t${plan.command.join(" ")}${envNote}`);
		console.log(JSON.stringify(plan, null, 2));
		return;
	}

	// Pi peers load Fleet extensions/harnesses. Validate all three isolated npm
	// roots before creating a pane so an import failure cannot turn into a peer
	// timeout or a misleading unknown-flag diagnostic. Claude peers do not load
	// this Pi runtime and retain their dedicated CLI preflight below.
	if (plan.runner === "pi") {
		try {
			assertRuntimeDependencies(REPO_ROOT);
		} catch (error) {
			die(`fleet peer: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// A PATH entry alone does not prove the CLI is runnable: interrupted npm
	// installs can leave a valid `claude` symlink targeting a non-executable
	// placeholder. Refuse before creating a pane (and before the 45s registry
	// wait) rather than reporting the dependency failure as a peer timeout.
	if (plan.runner === "claude-code") {
		try {
			assertClaudeCodeAvailable();
		} catch (error) {
			die(`fleet peer: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// --here: become the peer in this terminal. The env_file is applied to our
	// own child rather than to a pane, and there is nothing to wait for — the
	// peer is the foreground process.
	if (plan.placement === "here") {
		const [bin, ...rest] = plan.command;
		const result = spawnSync(bin, rest, {
			stdio: "inherit",
			cwd: REPO_ROOT,
			env: { ...process.env, ...paneEnv(plan) },
		});
		if (result.error) die(`fleet peer: could not run ${bin}: ${result.error.message}`);
		process.exitCode = result.status ?? 1;
		return;
	}

	const env = paneEnv(plan);

	// Import lazily so --dry-run and --here never touch the client (or the socket).
	const { herdr, requireHerdr, HerdrUnavailableError } = await import("../.pi/harnesses/lib/herdr-client.ts");
	try {
		await requireHerdr();
	} catch (err) {
		if (err instanceof HerdrUnavailableError) {
			console.error(err.message);
			console.error(`(no herdr? run it in this terminal instead: just fleet peer ${plan.name} --here)`);
			process.exit(1);
		}
		throw err;
	}

	let paneId: string;
	if (inPane) {
		const { pane } = await herdr.paneSplit({
			target_pane_id: inPane,
			direction: plan.direction,
			cwd: REPO_ROOT,
			...(Object.keys(env).length > 0 ? { env } : {}),
			focus: false,
		});
		paneId = pane.pane_id;
		try {
			await herdr.paneRename(paneId, plan.name);
		} catch {
			// non-fatal: an unlabelled pane is cosmetic
		}
		// pane.split opens a bare shell — the argv has to be typed into it.
		const launch = await launchPeerInPane(herdr, paneId, plan.command);
		if (!launch.promptSeen) {
			console.error(`⚠ pane ${paneId} showed no shell prompt within ${Math.round(PANE_PROMPT_TIMEOUT_MS / 1000)}s; the command was sent anyway.`);
		}
		console.log(`Launched ${plan.name} [${plan.kind}] in pane ${paneId}: ${plan.command.join(" ")}`);
	} else {
		const { workspaces } = await herdr.workspaceList();
		const existing = workspaces.find((w) => w.label === plan.workspaceLabel);
		if (existing) {
			console.error(`herdr workspace "${plan.workspaceLabel}" already exists (${existing.workspace_id}).`);
			console.error(`  focus: herdr workspace focus ${existing.workspace_id}`);
			console.error(`  close: herdr workspace close ${existing.workspace_id}`);
			process.exit(1);
		}
		const created = await herdr.workspaceCreate({ label: plan.workspaceLabel, cwd: REPO_ROOT, focus: false });
		const wsId = created.workspace.workspace_id;
		const initialTab = created.workspace.active_tab_id ?? created.tab?.tab_id;
		// layout.apply pane nodes DO carry an argv, so no prompt-typing here.
		const root: LayoutNode = {
			type: "pane",
			command: plan.command,
			cwd: REPO_ROOT,
			label: plan.name,
			...(Object.keys(env).length > 0 ? { env } : {}),
		};
		await herdr.layoutApply({ workspace_id: wsId, root });
		if (initialTab) {
			try {
				await herdr.tabClose(initialTab);
			} catch {
				// non-fatal: an extra empty tab is cosmetic
			}
		}
		// layout.apply assigns the pane id; resolve it by label so the readiness
		// report can quote the pane's own output when the peer never registers.
		paneId = await paneIdByLabel(herdr, wsId, plan.name);
		console.log(`Launched ${plan.name} [${plan.kind}] in herdr workspace "${plan.workspaceLabel}" (${wsId}): ${plan.command.join(" ")}`);
		console.log(`Focus: herdr workspace focus ${wsId}`);
		console.log(`Close: herdr workspace close ${wsId}`);
	}

	// A peer that never registers is a FAILED start, not a slow one — say so
	// rather than leaving the caller to guess from a pane id.
	const { found, waitedMs } = await waitForRegistration(plan);
	if (found) {
		console.log(
			`Peer "${plan.name}" is ready in pane ${paneId} after ${Math.round(waitedMs / 1000)}s — ` +
				`address it with: node --experimental-strip-types scripts/coms-cli.ts send ${plan.name} "…" --project ${plan.project} --name <you>\n` +
				"It boots idle and does no work until you send.",
		);
		return;
	}
	const tail = (await paneTail(herdr, paneId)).trim();
	console.error(
		`Peer "${plan.name}" did not register in the coms pool within ${Math.round(PEER_READY_TIMEOUT_MS / 1000)}s — ` +
			"assume it failed to start rather than that it is slow. Do not send to it." +
			(tail ? `\n\nLast output of pane ${paneId}:\n${tail}` : ""),
	);
	process.exitCode = 1;
}

/** Pane id of the pane labelled `label` in a workspace; "?" when unresolvable. */
async function paneIdByLabel(client: { paneList(p: { workspace_id?: string }): Promise<{ panes: { pane_id: string; label?: string }[] }> }, workspaceId: string, label: string): Promise<string> {
	try {
		const { panes } = await client.paneList({ workspace_id: workspaceId });
		return panes.find((p) => p.label === label)?.pane_id ?? panes[0]?.pane_id ?? "?";
	} catch {
		return "?";
	}
}

/** Last lines of a pane, for reporting why a launch failed. Never throws. */
async function paneTail(client: { paneRead(p: { pane_id: string; lines: number }): Promise<{ read: { text?: string } }> }, paneId: string, lines = 12): Promise<string> {
	if (paneId === "?") return "";
	try {
		const { read } = await client.paneRead({ pane_id: paneId, lines });
		return read?.text ?? "";
	} catch {
		return "";
	}
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) void main();
