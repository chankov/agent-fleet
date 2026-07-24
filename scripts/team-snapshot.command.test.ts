import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { teamWorkspaceLabel, worktreeTag } from "./lib/team-project.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "team-snapshot.ts");

type Request = { id: string; method: string; params: Record<string, unknown> };

async function startFakeHerdr(workspaces: Array<{ workspace_id: string; label: string }>) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "team-snapshot-herdr-"));
	const socketPath = path.join(root, "herdr.sock");
	const requests: Request[] = [];
	const server = net.createServer((socket) => {
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				const request = JSON.parse(line) as Request;
				requests.push(request);
				const result = request.method === "ping"
					? { type: "pong", version: "fake", protocol: 14 }
					: request.method === "workspace.list"
						? { workspaces }
						: request.method === "pane.list"
							? { panes: [] }
							: request.method === "agent.list"
								? { agents: [] }
								: {};
				socket.end(JSON.stringify({ id: request.id, result }) + "\n");
			}
		});
	});
	await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
	return {
		socketPath,
		requests,
		close: async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}

function runDown(team: string, project: string, socketPath: string, home: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", SCRIPT, "down", team, "--project", project], {
			cwd: REPO_ROOT,
			env: { ...process.env, HERDR_SOCKET_PATH: socketPath, HOME: home },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
		child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

test("down accepts declared empty base and closes only its scoped hub workspace", async (t) => {
	const project = "empty-team-regression";
	const hubLabel = teamWorkspaceLabel("hub", "base", project, worktreeTag(REPO_ROOT));
	const fake = await startFakeHerdr([
		{ workspace_id: "unscoped-base", label: teamWorkspaceLabel("hub", "base", "default", worktreeTag(REPO_ROOT)) },
		{ workspace_id: "scoped-base", label: hubLabel },
	]);
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "team-snapshot-home-"));
	t.after(async () => {
		await fake.close();
		fs.rmSync(home, { recursive: true, force: true });
	});

	const result = await runDown("base", project, fake.socketPath, home);

	assert.equal(result.code, 0, result.stderr);
	assert.match(result.stdout, /Closed workspace scoped-base/);
	assert.deepEqual(
		fake.requests.filter((request) => request.method === "workspace.close").map((request) => request.params),
		[{ workspace_id: "scoped-base" }],
	);
});

test("down rejects an undeclared team rather than treating it as empty", async (t) => {
	const fake = await startFakeHerdr([{ workspace_id: "missing-team", label: teamWorkspaceLabel("hub", "missing", "missing-team", worktreeTag(REPO_ROOT)) }]);
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "team-snapshot-home-"));
	t.after(async () => {
		await fake.close();
		fs.rmSync(home, { recursive: true, force: true });
	});

	const result = await runDown("missing", "missing-team", fake.socketPath, home);

	assert.equal(result.code, 1);
	assert.match(result.stderr, /Team "missing" not found in peers\.yaml\./);
	assert.equal(fake.requests.some((request) => request.method === "workspace.close"), false);
});
