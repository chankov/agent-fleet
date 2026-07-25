/**
 * Disposable, production-shaped monitor scenario.
 *
 * Every seam here is the real runtime: `MonitorRegistry`, `MonitorSocketServer`,
 * `MonitorEventJournal`, `MonitorInvokeJournal`, the session bridge, the monitor
 * lifecycle, and the production follow-up enqueue seam. There is no hand-stub
 * that can turn an unsupported route into a success.
 *
 * Nothing here proves Gate O, live origin delivery, steering, or surgical
 * runtime use. Recovery mechanics driven through `synthetic-local` commands are
 * a labeled local test boundary, never capability evidence.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { MonitorRegistry } from "./lib/hermes-monitor-registry.ts";
import { MonitorSocketServer } from "./lib/hermes-monitor-socket.ts";
import { FakeHerdrServer } from "./lib/fake-herdr-server.ts";
import { watchHubMonitor } from "./lib/hermes-monitor-herdr.ts";
import { createMonitorInvokeAdmission, createWatchdogFollowUpEnqueue } from "../.pi/harnesses/agent-hub/monitor-invoke.ts";
import { MonitorInvokeJournal } from "../.pi/harnesses/agent-hub/monitor-invoke-journal.ts";
import { createViewerGatedMonitor } from "../.pi/harnesses/agent-hub/monitor-publisher.ts";
import { createMonitorSessionBridge } from "../.pi/harnesses/agent-hub/monitor-session-bridge.ts";
import { MonitorRuntime } from "../.pi/harnesses/agent-hub/monitor-runtime.ts";
import { MonitorEventJournal } from "../.pi/harnesses/lib/hermes-monitor-events.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WATCHER_ENTRYPOINT = path.join(repoRoot, "hermes", "skills", "hub-watchdog", "scripts", "watchdog.py");

const HUB_INSTANCE_ID = "hub";
const PROFILE_ID = "scenario";
const UDS_TIMEOUT_MS = 1_000;
const DEFAULT_WAIT_TIMEOUT_MS = 5_000;
// Polling a busy UDS every 5ms can starve the real Python child's 2s long-poll
// from being scheduled during owner rollover. This is only a test barrier; the
// watcher's production events() cycle remains 2s.
const WAIT_POLL_MS = 25;

export type WatcherChild = {
	child: ChildProcess;
	stateDir: string;
	auditPath: string;
	stdout: string[];
	stderr: string[];
	exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

export type Scenario = {
	root: string;
	tasks: Map<string, any>;
	visible: boolean;
	counters: { polls: number; outputs: number };
	bridge?: any;
	registration?: any;
	server?: any;
	herdr?: any;
	hybrid?: any;
	viewer?: any;
	statuses: any[];
	outputs: any[];
	clock: any;
	disposables: Set<() => any>;
	/** Follow-ups rendered by the production seam, in order. */
	followUps: Array<{ message: any; options: any }>;
	/** Queue depth the invoke admission reads; raise it to force `queue_full`. */
	queueDepth: number;
	queueLimit: number;
	/** Real disposable child processes standing in for native specialists. */
	natives: Map<string, { child: ChildProcess; exit: Promise<number | null> }>;
	cancels: Array<{ taskId: string; generation: number }>;
	watcher?: WatcherChild;
	eventJournal?: MonitorEventJournal;
};

export function createScenario(root: string, options: any = {}): Scenario {
	root = path.resolve(root);
	if (root === path.parse(root).root) throw Error("owned scenario root required");
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	fs.chmodSync(root, 0o700);
	return {
		root,
		tasks: new Map(),
		visible: false,
		counters: { polls: 0, outputs: 0 },
		statuses: [],
		outputs: [],
		clock: options.clock ?? { setInterval, clearInterval, setTimeout, clearTimeout, now: Date.now },
		disposables: new Set(),
		followUps: [],
		queueDepth: 0,
		queueLimit: options.queueLimit ?? 1,
		natives: new Map(),
		cancels: [],
	};
}

/** Register cleanup exactly once; repeated `stop-owned` runs stay idempotent. */
export function registerDisposable(s: Scenario, dispose: () => any) {
	let done = false;
	s.disposables.add(async () => {
		if (done) return;
		done = true;
		await dispose();
	});
}

/**
 * Poll a condition instead of sleeping. Every scenario barrier goes through
 * this so a loaded machine slows the test down rather than flaking it.
 */
export async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	options: { label?: string; timeoutMs?: number } = {},
): Promise<void> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await predicate()) return;
		if (Date.now() >= deadline) throw Error(`timed out waiting for ${options.label ?? "condition"} after ${timeoutMs}ms`);
		await new Promise(resolve => setTimeout(resolve, WAIT_POLL_MS));
	}
}

function uds(socketPath: string, frame: any): Promise<any> {
	return new Promise((resolve, reject) => {
		let text = "";
		const client = net.createConnection(socketPath);
		client.setTimeout(UDS_TIMEOUT_MS, () => client.destroy(Error("scenario timeout")));
		client.on("connect", () => client.end(JSON.stringify(frame) + "\n"));
		client.on("data", chunk => { text += chunk; });
		client.on("close", () => resolve(text ? JSON.parse(text) : null));
		client.on("error", reject);
	});
}

/** sha256 of the hub instance id — the namespace directory the watcher reads. */
export function hubKeyFor(hubInstanceId: string = HUB_INSTANCE_ID): string {
	return crypto.createHash("sha256").update(hubInstanceId).digest("hex");
}

// ── serve ────────────────────────────────────────────────────────────────────

function buildRegistration(s: Scenario) {
	const profile = path.join(s.root, "profile");
	fs.mkdirSync(profile, { recursive: true, mode: 0o700 });

	const journal = new MonitorEventJournal({ file: path.join(s.root, "events.ndjson"), now: () => new Date(s.clock.now()) });
	const bridge = createMonitorSessionBridge({
		now: () => new Date(s.clock.now()),
		events: journal,
		runtime: new MonitorRuntime({ runtimeDir: s.root, profileId: PROFILE_ID, hubInstanceId: HUB_INSTANCE_ID }),
	});
	const registration: any = new MonitorRegistry({ runtimeDir: s.root }).register({
		profilePath: profile,
		profileId: PROFILE_ID,
		hubInstanceId: HUB_INSTANCE_ID,
		snapshot: () => bridge.snapshot(),
	});
	bridge.setEventIdentity({ profileKey: registration.profileKey, hubInstanceId: HUB_INSTANCE_ID });
	bridge.setCurrentOwner({
		ownerSessionId: registration.ownerId,
		ownerLeaseExpiresAt: registration.leaseExpiresAt,
		updateActive: true,
	});

	const invokeJournal = new MonitorInvokeJournal(path.join(s.root, "invokes.ndjson"));
	registration.output = (request: any) => { s.counters.outputs++; return bridge.readOutput(request); };
	registration.events = (request: any) => journal.replay(request.afterSequence, request.limit, request.waitMs, request.signal);
	registration.cancel = (request: any) => cancelNative(s, request);
	registration.invoke = createMonitorInvokeAdmission({
		journal: invokeJournal,
		task: (id: string, generation: number) => bridge.snapshot().tasks.find((task: any) => task.id === id && task.generation === generation),
		owner: () => registration.ownerId,
		queueDepth: () => s.queueDepth,
		queueLimit: s.queueLimit,
		// The one production seam: the same renderer `index.ts` uses.
		enqueue: createWatchdogFollowUpEnqueue((message, options) => { s.followUps.push({ message, options }); }),
		publish: (kind: any, task: any) => bridge.publishEvent(kind, task),
	});

	return { bridge, registration, journal };
}

async function serve(s: Scenario) {
	if (s.server) return { socketPath: s.registration.socketPath };
	const { bridge, registration, journal } = buildRegistration(s);
	const server = new MonitorSocketServer(registration);
	await server.listen();

	s.bridge = bridge;
	s.registration = registration;
	s.server = server;
	s.eventJournal = journal;
	s.herdr = await FakeHerdrServer.start({ paneId: "pane", workspaceId: "workspace", resyncOutput: { sequence: 1, text: "resync" } });

	const env: any = { HERDR_ENV: "1", HERDR_PANE_ID: "pane", HERDR_SOCKET_PATH: s.herdr.socketPath };
	s.hybrid = watchHubMonitor({
		env,
		reconnectDelayMs: 1,
		onStatus: (value: any) => s.statuses.push(value),
		onOutput: (value: any) => s.outputs.push(value),
	});
	s.viewer = createViewerGatedMonitor({
		pollMetadata: async () => { s.counters.polls++; return []; },
		fetchOutput: async () => ({ sequence: 0 }),
		intervalMs: 1,
	});

	registerDisposable(s, () => s.hybrid?.close());
	registerDisposable(s, () => s.viewer?.stop());
	registerDisposable(s, () => s.herdr?.close());
	registerDisposable(s, () => stopWatcher(s));
	registerDisposable(s, () => stopNatives(s));
	// Owns whichever registration is current at teardown, so an owner rollover
	// never leaves a second disposable trying to close an already-closed server.
	registerDisposable(s, () => closeCurrentRegistration(s));

	return { socketPath: registration.socketPath, token: registration.token };
}

async function closeCurrentRegistration(s: Scenario) {
	const server = s.server;
	const registration = s.registration;
	s.server = null;
	s.registration = undefined;
	if (server) await server.close();
	registration?.cleanup?.();
}

/** Re-register under a fresh owner so consumers must rediscover token and socket. */
async function rollOwner(s: Scenario) {
	if (!s.server) throw Error("serve first");
	const previousSocket = s.registration.socketPath;
	await closeCurrentRegistration(s);
	// Explicit release gate: never publish a replacement until the old owned
	// socket has been released, regardless of a loaded watcher's long-poll.
	await waitFor(() => !fs.existsSync(previousSocket), { label: "previous owner socket release" });
	const { bridge, registration, journal } = buildRegistration(s);
	const server = new MonitorSocketServer(registration);
	await server.listen();
	s.bridge = bridge;
	s.registration = registration;
	s.server = server;
	s.eventJournal = journal;
	return { ownerId: registration.ownerId, socketPath: registration.socketPath };
}

// ── real disposable native children ──────────────────────────────────────────

/** A real child process that idles until it is signalled — never a stub. */
function startNative(s: Scenario, id: string, generation: number) {
	const key = `${id}:${generation}`;
	if (s.natives.has(key)) throw Error(`native ${key} already running`);
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	const exit = new Promise<number | null>(resolve => child.once("close", code => resolve(code)));
	s.natives.set(key, { child, exit });
	return { pid: child.pid, key };
}

/** Cancel only the exact task/generation the request names. */
async function cancelNative(s: Scenario, request: { taskId: string; generation: number }) {
	s.cancels.push({ taskId: request.taskId, generation: request.generation });
	const key = `${request.taskId}:${request.generation}`;
	const native = s.natives.get(key);
	if (!native) return { cancelled: false, reason: "unsupported" };
	native.child.kill("SIGTERM");
	await native.exit;
	s.natives.delete(key);
	s.bridge?.finishChild?.(request.taskId, "cancelled");
	return { cancelled: true, state: "cancelled" };
}

async function stopNatives(s: Scenario) {
	for (const [, native] of s.natives) {
		native.child.kill("SIGKILL");
		await native.exit;
	}
	s.natives.clear();
}

// ── real foreground watcher child ────────────────────────────────────────────

/**
 * Launch the shipped `watchdog.py watch` process as a real foreground child with
 * a disposable HOME/XDG/profile/runtime environment and Gate O absent. It runs
 * in `observe` mode, so it may only read events and journal them.
 */
function startWatcher(s: Scenario, options: { autonomy?: string } = {}): WatcherChild {
	if (s.watcher) throw Error("watcher already running");
	if (!s.registration) throw Error("serve first");
	const home = path.join(s.root, "watcher-home");
	const stateDir = path.join(s.root, "watcher-state");
	const lockDir = path.join(s.root, "watcher-lock");
	for (const directory of [home, stateDir, lockDir]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

	const invocation = {
		// Gate O is deliberately absent: no `gateO` key at all.
		autonomy: options.autonomy ?? "observe",
		maximumAutonomy: "observe",
		profileId: PROFILE_ID,
		profileKey: s.registration.profileKey,
		hubKey: hubKeyFor(),
		hubInstanceId: HUB_INSTANCE_ID,
		runtimeDir: s.root,
		stateDir,
		lockDir,
	};
	const child = spawn("python3", [WATCHER_ENTRYPOINT, "watch", "--invocation-json", JSON.stringify(invocation)], {
		cwd: path.dirname(WATCHER_ENTRYPOINT),
		env: {
			PATH: process.env.PATH ?? "",
			HOME: home,
			XDG_STATE_HOME: path.join(home, "state"),
			XDG_RUNTIME_DIR: lockDir,
			PYTHONDONTWRITEBYTECODE: "1",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const stdout: string[] = [];
	const stderr: string[] = [];
	child.stdout?.on("data", chunk => stdout.push(String(chunk)));
	child.stderr?.on("data", chunk => stderr.push(String(chunk)));
	const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve =>
		child.once("close", (code, signal) => resolve({ code, signal })));

	// The watcher scopes its private state by a hash of the profile id, never the
	// raw name, so the audit path has to be derived the same way.
	const profileRoot = crypto.createHash("sha256").update(PROFILE_ID).digest("hex");
	s.watcher = {
		child,
		stateDir,
		auditPath: path.join(stateDir, "agent-fleet", "hermes-watchdog", profileRoot, "audit.ndjson"),
		stdout,
		stderr,
		exit,
	};
	return s.watcher;
}

/** Every audit decision the watcher has journaled so far. */
export function watcherAudit(s: Scenario): any[] {
	const watcher = s.watcher;
	if (!watcher || !fs.existsSync(watcher.auditPath)) return [];
	return fs.readFileSync(watcher.auditPath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line));
}

/** SIGINT the watcher and wait for it to release its lock and exit. */
async function stopWatcher(s: Scenario) {
	const watcher = s.watcher;
	if (!watcher) return { stopped: false };
	if (watcher.child.exitCode === null && watcher.child.signalCode === null) watcher.child.kill("SIGINT");
	const result = await watcher.exit;
	s.watcher = undefined;
	return { stopped: true, ...result };
}

/** Any `watch.lock` still present under the watcher's lock root. */
export function watcherLocks(s: Scenario, lockDir = path.join(s.root, "watcher-lock")): string[] {
	const root = path.join(lockDir, "agent-fleet-hermes-watchdog");
	if (!fs.existsSync(root)) return [];
	const found: string[] = [];
	const visit = (directory: string) => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const full = path.join(directory, entry.name);
			if (entry.isDirectory()) visit(full);
			else if (entry.name === "watch.lock") found.push(full);
		}
	};
	visit(root);
	return found;
}

// ── apply ────────────────────────────────────────────────────────────────────

async function apply(s: Scenario, args: string[]) {
	if (args[0] === "status") { s.herdr.emitStatus(); return true; }
	if (args[0] === "disconnect") { s.herdr.disconnectSubscribers(); return true; }
	if (args[0] === "reconnect") { s.herdr.setWorkspaceId(args[1] ?? "workspace"); s.herdr.emitStatus(); return true; }
	if (!s.bridge) throw Error("serve first");

	const [action, id, value] = args;
	if (action === "owner") {
		s.bridge.setCurrentOwner({ ownerSessionId: id, ownerLeaseExpiresAt: value, updateActive: true });
		return true;
	}
	if (action === "parent") return s.bridge.startParent({ id, hubInstanceId: HUB_INSTANCE_ID, checkoutId: PROFILE_ID });
	if (action === "child") {
		return s.bridge.startChild({ key: id, id, generation: 1, parentId: value, parentGeneration: 1, specialist: "fake" }, {});
	}
	if (action === "output" || action === "late") return s.bridge.appendOutput(id, value ?? "");
	if (action === "wait-only") return s.bridge.registerWaitOnly(id, async () => {});
	if (action === "cancel-wait") return s.bridge.cancelWaitOnly(id, { kind: "scenario_cancel" });
	if (action === "evidence-loss") return s.bridge.reconcile({ owner: false, socket: false, session: false, herdr: false });
	if (action === "transition") return s.bridge.finishChild(id, value);
	throw Error("unsupported apply");
}

// ── get ──────────────────────────────────────────────────────────────────────

function get(s: Scenario, args: string[]) {
	if (!s.registration) throw Error("serve first");
	const [kind = "snapshot", id, generation = "1", after = "0"] = args;
	const { socketPath, token } = s.registration;
	s.counters.polls++;
	if (kind === "output") {
		return uds(socketPath, { type: "output", token, taskId: id, generation: Number(generation), afterSequence: Number(after) });
	}
	if (kind === "events") {
		return uds(socketPath, { type: "events", token, afterSequence: Number(after), limit: 100, waitMs: 0 });
	}
	if (kind === "invoke") return uds(socketPath, { type: "invoke", token, ...JSON.parse(id!) });
	if (kind === "cancel") return uds(socketPath, { type: "cancel", token, taskId: id, generation: Number(generation) });
	return uds(socketPath, { type: "snapshot", token });
}

// ── command dispatch ─────────────────────────────────────────────────────────

export async function execute(s: Scenario, argv: string[]): Promise<any> {
	const [command, ...args] = argv;
	if (!command) throw Error("scenario command required");

	if (command === "serve") return serve(s);
	if (command === "roll-owner") return rollOwner(s);
	if (command === "apply") return apply(s, args);
	if (command === "get") return get(s, args);

	if (command === "watcher") {
		if (args[0] === "start") return startWatcher(s, { autonomy: args[1] });
		if (args[0] === "audit") return watcherAudit(s);
		if (args[0] === "stop") return stopWatcher(s);
		if (args[0] === "locks") return watcherLocks(s);
		throw Error("unsupported watcher command");
	}
	if (command === "native") {
		if (args[0] === "start") return startNative(s, args[1]!, Number(args[2] ?? 1));
		if (args[0] === "alive") return s.natives.has(`${args[1]}:${args[2] ?? 1}`);
		throw Error("unsupported native command");
	}
	if (command === "queue") { s.queueDepth = Number(args[0]); return { queueDepth: s.queueDepth, queueLimit: s.queueLimit }; }
	if (command === "follow-ups") return s.followUps;
	if (command === "cancels") return s.cancels;

	if (command === "visibility") {
		s.visible = args[0] === "show";
		s.viewer?.setViewers(s.visible ? 1 : 0);
		return { visible: s.visible };
	}
	if (command === "counters") {
		return { ...s.counters, statuses: s.statuses.length, outputs: s.outputs.length, subscriptions: s.herdr?.subscriptionCount() ?? 0 };
	}
	if (command === "wait") return s.bridge?.snapshot() ?? [];
	if (command === "assert") {
		if (args[0] !== "visible" || String(s.visible) !== args[1]) throw Error("assertion failed");
		return true;
	}
	if (command === "stop-owned") {
		for (const dispose of [...s.disposables]) await dispose();
		s.disposables.clear();
		s.server = null;
		return true;
	}
	if (command === "wait-owned") {
		if (s.disposables.size) throw Error("owned handles remain");
		return { live: false, handles: 0 };
	}
	throw Error("unsupported scenario command");
}
