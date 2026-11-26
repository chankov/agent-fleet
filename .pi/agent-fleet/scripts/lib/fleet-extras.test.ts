// Track B tests: env_file path guarding (B3), persona banners (B1), and the
// one-pane Herdr launcher (`just fleet --herdr`, `just fleet conductor hermes`)
// via the real script — dry runs need no herdr, and the live launch talks to a
// fake herdr socket.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveEnvFilePath } from "./herdr-layout.ts";
import { parsePersonaFrontmatter, renderBanner } from "./persona-banner.ts";
import { worktreeTag } from "./team-project.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const HERDR_HUB = join(REPO_ROOT, ".pi", "agent-fleet", "scripts", "herdr-hub.ts");
// The launcher derives the workspace-label prefix from the checkout basename,
// so the expected label depends on where this repo is cloned.
const TAG = worktreeTag(REPO_ROOT);

test("resolveEnvFilePath accepts repo-relative paths and rejects escapes", () => {
	assert.equal(resolveEnvFilePath(".env.peer", "/repo"), "/repo/.env.peer");
	assert.equal(resolveEnvFilePath("config/peer.env", "/repo"), "/repo/config/peer.env");
	assert.throws(() => resolveEnvFilePath("/etc/passwd", "/repo"), /must be repo-relative/);
	assert.throws(() => resolveEnvFilePath("../outside.env", "/repo"), /escapes the repo root/);
	assert.throws(() => resolveEnvFilePath("a/../../outside.env", "/repo"), /escapes the repo root/);
	assert.throws(() => resolveEnvFilePath("bad value.env", "/repo"), /Unsafe env_file path/);
});

test("persona frontmatter parses name/description/color like the coms harness", () => {
	const meta = parsePersonaFrontmatter(
		'---\nname: researcher\ndescription: "Digs up sources"\ncolor: "#72F1B8"\n---\nbody',
	);
	assert.equal(meta.name, "researcher");
	assert.equal(meta.description, "Digs up sources");
	assert.equal(meta.color, "#72F1B8");
	assert.deepEqual(parsePersonaFrontmatter("no frontmatter here"), {});
});

test("renderBanner colors the name, includes the purpose, tolerates bad colors", () => {
	const lines = renderBanner("researcher", { description: "Digs up sources", color: "#72F1B8" }, 40);
	assert.equal(lines.length, 4);
	assert.match(lines[1], /38;2;114;241;184/); // #72F1B8 as RGB
	assert.match(lines[1], /researcher/);
	assert.match(lines[2], /Digs up sources/);
	// invalid color falls back without throwing; missing purpose drops the line
	const plain = renderBanner("x", { color: "not-a-color" }, 40);
	assert.equal(plain.length, 3);
});

// No live herdr may ever be reached from these tests: every run points
// HERDR_SOCKET_PATH at a path nothing listens on unless a fake is started.
function herdrHub(args: string[], env: Record<string, string> = {}): { stdout: string; stderr: string; status: number | null } {
	const r = spawnSync(process.execPath, [HERDR_HUB, ...args], {
		encoding: "utf-8",
		cwd: REPO_ROOT,
		env: { ...process.env, HERDR_SOCKET_PATH: join(tmpdir(), "no-herdr-here.sock"), AF_SESSION_ROOTS: "", AGENT_FLEET_MONITOR: "0", ...env },
	});
	return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

function parseDry(stdout: string): any {
	return JSON.parse(stdout.slice(stdout.indexOf("{")));
}

test("dry run: the Hub alone in one pane, labelled <tag>-hub-base, with the project", () => {
	const plain = herdrHub(["--dry-run"]);
	assert.equal(plain.status, 0, plain.stderr);
	assert.deepEqual(parseDry(plain.stdout), {
		label: `${TAG}-hub-base`,
		layout: { type: "pane", command: ["just", "fleet"], cwd: REPO_ROOT, label: "hub" },
	});

	const scoped = herdrHub(["--project", "acme", "--dry-run"]);
	assert.equal(scoped.status, 0, scoped.stderr);
	assert.match(scoped.stdout, /project "acme"/);
	const parsed = parseDry(scoped.stdout);
	assert.equal(parsed.label, `${TAG}-hub-base--project.acme`);
	assert.deepEqual(parsed.layout.command, ["just", "fleet", "--project", "acme"]);
	assert.equal("env" in parsed.layout, false, "dry run reads no monitor state");
});

test("dry run: the Hub's own flags reach its pane command", () => {
	const r = herdrHub(["--no-coms", "--browser", "--voice", "--all-extensions", "--project", "af", "--dry-run"]);
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(parseDry(r.stdout).layout.command, [
		"just", "fleet", "--no-coms", "--browser", "--voice", "--all-extensions", "--project", "af",
	]);
});

test("dry run: the Hermes conductor takes the single pane on the same launcher", () => {
	const named = herdrHub(["--conductor", "hermes", "--name", "docs", "--project", "af", "--dry-run"]);
	assert.equal(named.status, 0, named.stderr);
	assert.deepEqual(parseDry(named.stdout), {
		label: `${TAG}-conductor-hermes-docs--project.af`,
		layout: { type: "pane", command: ["hermes", "-p", "dev"], cwd: REPO_ROOT, label: "conductor-hermes" },
	});
	const unnamed = herdrHub(["--conductor", "hermes", "--dry-run"]);
	assert.equal(parseDry(unnamed.stdout).label, `${TAG}-conductor-hermes-full`);
});

test("invalid launcher arguments refuse before any output", () => {
	for (const [args, message] of [
		[["--model", "m/x", "--dry-run"], /Unknown argument: --model \(this launcher forwards no Pi arguments\)/],
		[["--team", "docs", "--dry-run"], /Unknown argument: --team/],
		[["--conductor", "codex", "--dry-run"], /Unknown conductor backend/],
		[["--conductor", "hermes", "--browser", "--dry-run"], /apply to the Hub pane, not the Hermes conductor/],
		[["--name", "x", "--dry-run"], /--name labels a conductor workspace/],
		[["--project", "bad value", "--dry-run"], /Invalid project name/],
		[["--project", "--dry-run"], /--project requires a value/],
		[["--dry-run", "--dry-run"], /may only be provided once/],
	] as const) {
		const r = herdrHub([...args]);
		assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
		assert.match(r.stderr, message);
		assert.equal(r.stdout, "");
	}
});

test("without a herdr server the launch refuses and points at the dry run", () => {
	const r = herdrHub(["--project", "acme"]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /dry run still works: just fleet --herdr --dry-run --project acme/);
});

type FakeRequest = { id: string; method: string; params: Record<string, unknown> };

async function startFakeHerdr(workspaces: Array<{ workspace_id: string; label: string }>) {
	const root = mkdtempSync(join(tmpdir(), "herdr-hub-fake-"));
	const socketPath = join(root, "herdr.sock");
	const requests: FakeRequest[] = [];
	const server = net.createServer((socket) => {
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				const request = JSON.parse(line) as FakeRequest;
				requests.push(request);
				const result = request.method === "ping"
					? { type: "pong", version: "fake", protocol: 14 }
					: request.method === "workspace.list"
						? { workspaces }
						: request.method === "workspace.create"
							? { workspace: { workspace_id: "w9", active_tab_id: "w9:t1" } }
							: {};
				socket.end(JSON.stringify({ id: request.id, result }) + "\n");
			}
		});
	});
	await new Promise<void>((done, fail) => server.listen(socketPath, done).once("error", fail));
	return {
		socketPath,
		requests,
		close: async () => {
			await new Promise<void>((done) => server.close(() => done()));
			rmSync(root, { recursive: true, force: true });
		},
	};
}

function launch(args: string[], socketPath: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((done, fail) => {
		const child = spawn(process.execPath, [HERDR_HUB, ...args], {
			cwd: REPO_ROOT,
			env: { ...process.env, HERDR_SOCKET_PATH: socketPath, AF_SESSION_ROOTS: "", AGENT_FLEET_MONITOR: "0" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
		child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
		child.on("error", fail);
		child.on("close", (code) => done({ code, stdout, stderr }));
	});
}

test("launch: creates one workspace, applies the one-pane layout and drops the empty tab", async (t) => {
	const fake = await startFakeHerdr([]);
	t.after(() => fake.close());
	const result = await launch(["--project", "acme"], fake.socketPath);
	assert.equal(result.code, 0, result.stderr);
	const methods = fake.requests.map((request) => request.method);
	assert.deepEqual(methods.filter((m) => m !== "ping"), ["workspace.list", "workspace.create", "layout.apply", "tab.close"]);
	const create = fake.requests.find((request) => request.method === "workspace.create")!;
	assert.equal(create.params.label, `${TAG}-hub-base--project.acme`);
	assert.equal(create.params.cwd, REPO_ROOT);
	const apply = fake.requests.find((request) => request.method === "layout.apply")!;
	assert.equal(apply.params.workspace_id, "w9");
	assert.deepEqual(apply.params.root, { type: "pane", command: ["just", "fleet", "--project", "acme"], cwd: REPO_ROOT, label: "hub" });
	assert.match(result.stdout, /Launched hub \(just fleet --project acme — guarded dispatcher\) in herdr workspace/);
});

test("launch: an existing workspace of the same label is refused, never clobbered", async (t) => {
	const fake = await startFakeHerdr([{ workspace_id: "w3", label: `${TAG}-conductor-hermes-full--project.af` }]);
	t.after(() => fake.close());
	const result = await launch(["--conductor", "hermes", "--project", "af"], fake.socketPath);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /already exists \(w3\)/);
	assert.equal(fake.requests.some((request) => request.method === "workspace.create" || request.method === "layout.apply"), false);
});
