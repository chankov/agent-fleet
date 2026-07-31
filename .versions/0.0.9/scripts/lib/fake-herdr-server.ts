import * as fs from "node:fs";
import * as net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeHerdrRequest {
	id: string;
	method: string;
	params: Record<string, unknown>;
}

export class FakeHerdrServer {
	public readonly requests: FakeHerdrRequest[] = [];
	public readonly socketPath: string;
	private readonly subscribers = new Set<net.Socket>();
	private readonly server: net.Server;
	private readonly root: string;
	private workspaceId: string;
	private readonly paneId: string;
	private readonly resyncOutput: { sequence: number; text: string };

	private constructor(socketPath: string, server: net.Server, root: string, paneId: string, workspaceId: string, resyncOutput: { sequence: number; text: string }) {
		this.socketPath = socketPath;
		this.server = server;
		this.root = root;
		this.paneId = paneId;
		this.workspaceId = workspaceId;
		this.resyncOutput = resyncOutput;
	}

	static async start(values: { paneId: string; workspaceId: string; resyncOutput?: { sequence: number; text: string } }): Promise<FakeHerdrServer> {
		const root = mkdtempSync(join(tmpdir(), "fake-herdr-"));
		const socketPath = join(root, "s");
		let fake: FakeHerdrServer;
		const server = net.createServer((socket) => {
			let buffer = "";
			socket.on("data", (chunk) => {
				buffer += chunk.toString("utf8");
				let newline: number;
				while ((newline = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					if (!line) continue;
					const request = JSON.parse(line) as FakeHerdrRequest;
					fake.requests.push(request);
					if (request.method === "events.subscribe") {
						fake.subscribers.add(socket);
						socket.write(JSON.stringify({ id: request.id, result: { type: "subscription_started" } }) + "\n");
						continue;
					}
					const result = request.method === "pane.get"
						? { pane: { pane_id: fake.paneId, workspace_id: fake.workspaceId, monitor_resync_output: fake.resyncOutput } }
						: request.method === "ping"
							? { type: "pong", version: "fake", protocol: 14 }
							: {};
					socket.end(JSON.stringify({ id: request.id, result }) + "\n");
				}
			});
			socket.on("close", () => fake.subscribers.delete(socket));
		});
		fake = new FakeHerdrServer(socketPath, server, root, values.paneId, values.workspaceId, values.resyncOutput ?? { sequence: 0, text: "" });
		await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
		return fake;
	}

	setWorkspaceId(workspaceId: string): void {
		this.workspaceId = workspaceId;
	}

	emitStatus(): void {
		for (const socket of this.subscribers) socket.write(JSON.stringify({ event: "pane.agent_status_changed", data: { pane_id: this.paneId } }) + "\n");
	}

	disconnectSubscribers(): void {
		for (const socket of this.subscribers) socket.destroy();
	}

	subscriptionCount(): number {
		return this.requests.filter((request) => request.method === "events.subscribe").length;
	}

	async close(): Promise<void> {
		this.disconnectSubscribers();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
		fs.rmSync(this.root, { recursive: true, force: true });
	}
}
