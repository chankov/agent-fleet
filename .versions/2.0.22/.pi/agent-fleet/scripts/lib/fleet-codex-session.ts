// Read-only Pi discovery and a private, per-ChatGPT selection. No peer writes.
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { readAllRegistryEntries, registryHeartbeatIsFresh, validateComsName, validateComsProject, type RegistryEntry } from "./coms-envelope.ts";

export interface Binding {
	version: 1;
	clientId: string;
	project: string;
	peer: string;
	sessionId: string;
	startedAt: string;
	selectedAt: string;
}
interface Options {
	stateDir: string;
	clientId?: string;
	readRegistry?: (project: string) => RegistryEntry[];
	now?: () => number;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nonempty = (s: unknown): s is string => typeof s === "string" && s.length > 0;

export class FleetSessionClient {
	private options: Options;
	constructor(options: Options) { this.options = options; }
	private now(): number { return (this.options.now ?? Date.now)(); }
	private id(): string {
		const id = this.options.clientId;
		if (!id || !UUID.test(id)) throw new Error("Valid CODEX_THREAD_ID required for binding operations");
		return id.toLowerCase();
	}
	private entries(project: string): RegistryEntry[] {
		return (this.options.readRegistry ?? readAllRegistryEntries)(validateComsProject(project));
	}
	private fresh(e: RegistryEntry): boolean {
		return nonempty(e.session_id) && nonempty(e.started_at) && Number.isFinite(Date.parse(e.started_at)) && registryHeartbeatIsFresh(e, this.now());
	}
	private view(project: string, e: RegistryEntry) {
		return {project, peer:e.name, sessionId:e.session_id, purpose:e.purpose, model:e.model, cwd:e.cwd,
			startedAt:e.started_at, heartbeatAt:e.heartbeat_at ?? null, presence:this.fresh(e) ? "available" : "unavailable",
			contextUsedPct:e.context_used_pct ?? null, queueDepth:e.queue_depth ?? null};
	}
	sessions(project: string) {
		const sessions = this.entries(project).filter(e => {
			try { validateComsName(e.name); return !e.explicit && nonempty(e.session_id); } catch { return false; }
		}).map(e => this.view(project, e));
		return {source:"coms_registry", observedAt:new Date(this.now()).toISOString(), sessions};
	}
	private file(): string { return path.join(path.resolve(this.options.stateDir), `${this.id()}.json`); }
	private safe(p: string, directory: boolean): boolean {
		try {
			const s = fs.lstatSync(p);
			if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile()) ||
				(process.getuid && s.uid !== process.getuid()) || (s.mode & 0o077)) throw new Error("unsafe binding storage");
			return true;
		} catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
	}
	private read(): Binding | null {
		const file = this.file();
		if (!this.safe(path.dirname(file), true) || !this.safe(file, false)) return null;
		try {
			if (fs.statSync(file).size > 8192) throw new Error();
			const b = JSON.parse(fs.readFileSync(file, "utf8")) as Binding;
			if (b.version !== 1 || b.clientId !== this.id() || !nonempty(b.project) || !nonempty(b.peer) ||
				!nonempty(b.sessionId) || !nonempty(b.startedAt) || !nonempty(b.selectedAt) ||
				!Number.isFinite(Date.parse(b.startedAt)) || !Number.isFinite(Date.parse(b.selectedAt))) throw new Error();
			validateComsProject(b.project); validateComsName(b.peer);
			return {version:1,clientId:b.clientId,project:b.project,peer:b.peer,sessionId:b.sessionId,startedAt:b.startedAt,selectedAt:b.selectedAt};
		} catch { throw new Error("invalid binding; inspect or detach before selecting again"); }
	}
	private mutate(binding: Binding | null): void {
		const file = this.file(); const dir = path.dirname(file);
		if (!this.safe(dir, true)) {
			if (binding === null) return;
			fs.mkdirSync(dir, {recursive:true,mode:0o700}); this.safe(dir, true);
		}
		const lock = `${file}.lock`;
		const fd = fs.openSync(lock, "wx", 0o600); // Refuse concurrent mutation; never steal a lock.
		const tmp = `${file}.${randomUUID()}.tmp`;
		try {
			this.safe(file, false);
			if (binding === null) { fs.rmSync(file, {force:true}); return; }
			fs.writeFileSync(tmp, JSON.stringify(binding), {flag:"wx",mode:0o600});
			fs.renameSync(tmp,file);
		} finally {
			fs.rmSync(tmp,{force:true}); fs.closeSync(fd); fs.unlinkSync(lock);
		}
	}
	select(project: string, peer: string) {
		this.id(); validateComsProject(project); validateComsName(peer);
		const matches = this.entries(project).filter(e => e.name === peer && !e.explicit);
		if (matches.length > 1) throw new Error("ambiguous peer registry");
		const e = matches[0];
		if (!e || !this.fresh(e)) throw new Error("peer unavailable: fresh session identity required");
		// Validate the existing record rather than silently replacing corrupt state.
		this.read();
		const binding: Binding = {version:1,clientId:this.id(),project,peer,sessionId:e.session_id,startedAt:e.started_at,selectedAt:new Date(this.now()).toISOString()};
		this.mutate(binding);
		return this.status();
	}
	status() {
		const binding = this.read();
		if (!binding) return {status:"unbound",binding:null};
		const matches = this.entries(binding.project).filter(e => e.name === binding.peer && !e.explicit);
		if (matches.length !== 1) return {status:matches.length ? "ambiguous" : "unavailable",binding};
		const e = matches[0];
		if (e.session_id !== binding.sessionId || e.started_at !== binding.startedAt) return {status:"stale",binding};
		return {status:this.fresh(e) ? "available" : "unavailable",binding,source:"coms_registry",observedAt:new Date(this.now()).toISOString(),session:this.view(binding.project,e)};
	}
	/** Current exact registry entry for read-only capability probes; never selects a replacement. */
	selectedEntry():RegistryEntry {
		const status=this.status();
		if(status.status!=='available'||!status.binding)throw Error(`target ${status.status}`);
		const b=status.binding;
		const entries=this.entries(b.project).filter(e=>!e.explicit&&e.name===b.peer);
		if(entries.length!==1||entries[0].session_id!==b.sessionId||entries[0].started_at!==b.startedAt||!this.fresh(entries[0]))throw Error('target changed during registry read');
		return entries[0];
	}

	readRuntime() {
		const binding = this.read();
		if (!binding) throw new Error("unbound");
		const runtime = this.file() + ".runtime";
		if (!this.safe(runtime,false)) return {binding,raw:null};
		if (fs.statSync(runtime).size > 4*1024*1024) throw new Error("runtime journal too large");
		return {binding,raw:fs.readFileSync(runtime,"utf8")};
	}

	/** Serialize sends, selection changes and cursor updates using the same lock. */
	async transaction<T>(action: (binding: Binding, entry: RegistryEntry, read: () => string | null, save: (json: string) => void) => Promise<T>): Promise<T> {
		const file = this.file();
		if (!this.safe(path.dirname(file), true)) throw new Error("unbound");
		const lock = file + ".lock";
		const fd = fs.openSync(lock, "wx", 0o600);
		const runtime = file + ".runtime";
		try {
			const status = this.status();
			if (status.status !== "available" || !status.binding) throw new Error(`target ${status.status}`);
			const binding = status.binding;
			const entry = this.entries(binding.project).find(e => e.name === binding.peer && e.session_id === binding.sessionId && e.started_at === binding.startedAt);
			if (!entry || !this.fresh(entry)) throw new Error("target changed");
			const read = () => {
				if (!this.safe(runtime,false)) return null;
				if (fs.statSync(runtime).size > 4*1024*1024) throw new Error("runtime journal too large");
				return fs.readFileSync(runtime,"utf8");
			};
			const save = (json: string) => {
				if (Buffer.byteLength(json) > 4*1024*1024) throw new Error("runtime journal full; inspect receipts");
				this.safe(runtime,false);
				const temp = runtime + `.${randomUUID()}.tmp`;
				try {
					const output = fs.openSync(temp,"wx",0o600);
					try { fs.writeFileSync(output,json); fs.fsyncSync(output); } finally { fs.closeSync(output); }
					fs.renameSync(temp,runtime);
					const directory = fs.openSync(path.dirname(file),"r");
					try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
				} finally { fs.rmSync(temp,{force:true}); }
			};
			return await action(binding, entry, read, save);
		} finally { fs.closeSync(fd); fs.unlinkSync(lock); }
	}

	detach() { this.mutate(null); return {status:"unbound",binding:null}; }
}
