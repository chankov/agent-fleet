import {sessionRootsFromEnv,validateSessionRoots,type SessionRoots} from '../../../../harnesses/lib/workspace-context.ts';
import { appendFileSync, mkdirSync, readFileSync, realpathSync, existsSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
const runNamespacePath: string = "../../../../../.pi/harnesses/agent-hub/run-namespace.js";
const { makeRunId } = await import(runNamespacePath) as { makeRunId(): string };

export type TraceEvent = Record<string, unknown> & { type: string; at: string; runId: string };

export class FlowTrace {
	readonly runId: string;
	readonly cwd: string;
	readonly directory: string;
	readonly file: string;
	private ended = false;
 private readonly roots?:SessionRoots;
 currentTarget():boolean{try{return sessionRootsFromEnv()?.targetId===this.roots?.targetId&&(!this.roots||validateSessionRoots(this.roots).targetId===this.roots.targetId);}catch{return false;}}

	constructor(options: { cwd?: string; runId?: string; command?: string[]; pid?: number; directory?: string } = {}) {
		this.runId = options.runId ?? makeRunId();
		this.cwd = resolve(options.cwd ?? process.cwd());
		this.roots=sessionRootsFromEnv();
  if(this.roots?.mode==='targeted'&&realpathSync(this.cwd)!==this.roots.executionRoot)throw Error('flow_trace_target_mismatch');
  const requestedDirectory=options.directory ? resolve(options.directory) : this.roots?.mode==='targeted'?resolve(this.roots.workspaceRoot,'.pi/flow-sessions/targets',this.roots.targetId,this.runId):resolve(this.cwd, ".pi", "flow-sessions", this.runId);
  // Normalize existing ancestors before containment checks (macOS /var aliases
  // and caller-provided session directories can name the same physical root).
  let canonicalDirectory=requestedDirectory;
  if(this.roots?.mode==='targeted'){
   let ancestor=requestedDirectory;
   while(!existsSync(ancestor)){const parent=dirname(ancestor);if(parent===ancestor)throw Error('flow_trace_storage_denied');ancestor=parent;}
   canonicalDirectory=resolve(realpathSync(ancestor),relative(ancestor,requestedDirectory));
  }
  this.directory=canonicalDirectory;
  if(this.roots?.mode==='targeted'){
   if(!this.directory.startsWith(resolve(this.roots.workspaceRoot,'.pi')+'/'))throw Error('flow_trace_outside_workspace');
   let parent=this.directory;while(!existsSync(parent))parent=dirname(parent);const canonical=realpathSync(parent);if(canonical!==this.roots.workspaceRoot&&!canonical.startsWith(this.roots.workspaceRoot+'/'))throw Error('flow_trace_storage_denied');
  }
		this.file = resolve(this.directory, "trace.jsonl");
		mkdirSync(this.directory, { recursive: true, mode:0o700 });
		this.write("run_start", { ...(this.roots?.mode==='targeted'?{sessionTarget:{targetId:this.roots.targetId,workspaceRoot:this.roots.workspaceRoot,executionRoot:this.roots.executionRoot,repositoryRoot:this.roots.repositoryRoot}}:{}), pid: options.pid ?? process.pid, command: options.command ?? process.argv });
	}

	write(type: string, data: Record<string, unknown> = {}): void {
		if (this.ended) return;
		const event: TraceEvent = { type, at: new Date().toISOString(), runId: this.runId, ...data };
		appendFileSync(this.file, `${JSON.stringify(event)}\n`, "utf8");
		if (type === "run_end") this.ended = true;
	}

	events(): TraceEvent[] {
		return readFileSync(this.file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
	}
}
