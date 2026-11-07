import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {permissionAuditOutcome,type PermissionRelay} from './permission-relay.ts';
import {sharedApprovalWait} from './approval-wait.ts';
import {damagePreview} from '../lib/damage-control-presentation.ts';
import {beginRuntimeTrace,type TraceBus} from '../lib/execution-trace.ts';
import {
	accessDecisionChoices,
	accessRequestCacheKey,
	appendExemptionToFile,
	fileExemptionsFor,
	type AccessDecision,
	type AccessDecisionChoice,
	type AccessRequest,
	type Exemption,
} from "../lib/damage-control-shared.ts";

type ApprovalContext = {
	hasUI: boolean;
	ui: {
		notify(message: string, level?: string): void;
		select(title: string, options: string[], settings: { timeout: number; signal?: AbortSignal }): Promise<string | undefined>;
	};
};

type ReplySocket = {
	destroyed?: boolean;
	on?(event: string, listener: () => void): unknown;
	removeListener?(event: string, listener: () => void): unknown;
	write(chunk: string): unknown;
	end(): unknown;
};

type AccessApprovalDeps = {
	traceBus?: TraceBus;
 relay?:PermissionRelay;
 taskIdentity?():{taskId:string;inputRevision:string};
 currentChild?(request:AccessRequest):boolean;
	getContext(): ApprovalContext | null | undefined;
	getExemptionsFile(): string | null | undefined;
	appendLog(entry: Record<string, unknown>): void;
 appendPermissionLog?(entry:Record<string,unknown>):void;
	now(): string;
};

export function createAccessApprovalRouter(deps: AccessApprovalDeps) {
	const askQueue = sharedApprovalWait;
	let generation = 0;
	const denyCache = new Set<string>();
	type PendingApproval = { controller: AbortController; waiters: number; promise: Promise<AccessDecisionChoice> };
	const pending = new Map<string, PendingApproval>();

	// A socket owns only its subscription, never the shared dialog's lifetime.
	const subscribe = (entry: PendingApproval, signal: AbortSignal): Promise<AccessDecisionChoice> => {
		entry.waiters++;
		return new Promise((resolve) => {
			let settled = false;
			const finish = (decision: AccessDecisionChoice) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener('abort', abort);
				entry.controller.signal.removeEventListener('abort', abort);
				if (--entry.waiters === 0) entry.controller.abort();
				resolve(decision);
			};
			const abort = () => finish('deny');
			signal.addEventListener('abort', abort, { once: true });
			entry.controller.signal.addEventListener('abort', abort, { once: true });
			if (signal.aborted || entry.controller.signal.aborted) abort();
			void entry.promise.then(finish, () => finish('deny'));
		});
	};

	const respond = (socket: ReplySocket, msgId: string, decision: AccessDecisionChoice, metadata:Partial<AccessDecision>={}) => {
		const reply: AccessDecision = { ...metadata,type: "access_decision", msg_id: msgId, decision };
		let queued=false;try { socket.write(JSON.stringify(reply) + "\n");queued=true; } catch { /* child may have timed out */ }
		try { socket.end(); } catch { /* ignore */ }
        return queued;
	};

	const validRequest = (request: AccessRequest) =>
		typeof request.pattern === "string" && request.pattern.length > 0 &&
		(request.category === "zero_access" || request.category === "read_only" || request.category === "no_delete") &&
		(request.deadline === undefined || (Number.isSafeInteger(request.deadline) && request.deadline > 0)) &&
		(request.actionDigest === undefined || /^[a-f0-9]{64}$/.test(request.actionDigest));

	const decide = (request: AccessRequest, signal: AbortSignal): Promise<AccessDecisionChoice> => {
		const agent = (typeof request.agent === "string" && request.agent) || request.sender_session || "unknown-agent";
		const pattern = request.pattern;
		const cacheKey = accessRequestCacheKey({ ...request, agent, pattern });
		const exemptionsFile = deps.getExemptionsFile();
		const requestGeneration = generation;

		if (fileExemptionsFor(exemptionsFile ?? undefined, agent).some((entry) => entry.pattern === pattern)) {
			return Promise.resolve("allow_all");
		}
		if (denyCache.has(cacheKey)) return Promise.resolve("deny");
		const existing = pending.get(cacheKey);
		if (signal.aborted) return Promise.resolve('deny');
		if (existing && !existing.controller.signal.aborted) return subscribe(existing, signal);
		const controller = new AbortController();

		const finishQueue=beginRuntimeTrace(deps.traceBus,{kind:'queue',id:request.msg_id,parentId:request.toolCallId,owner:request.traceOwner,source:'access-escalation',reason:'approval_queue'});
		const ask = askQueue.run(async (waitSignal): Promise<AccessDecisionChoice> => {
			finishQueue({status:'completed'});
			if (requestGeneration !== generation) return "deny";
			const ctx = deps.getContext();
			if (!ctx?.hasUI) return "deny";
			const finishTrace=beginRuntimeTrace(deps.traceBus,{kind:'approval',id:request.msg_id,parentId:request.toolCallId,owner:request.traceOwner,source:'access-escalation',tool:request.tool,rule:request.pattern,reason:request.category});

			const labels = new Map<AccessDecisionChoice, string>([
				["deny", "Deny (keep blocked)"],
				["allow_once", "Allow once"],
				["allow_agent", `Allow for ${agent} (this session)`],
				["allow_all", "Allow for all agents (this session)"],
			]);
			const allowed = accessDecisionChoices(request.category);
			const options = allowed.map((decision) => labels.get(decision)!);
			ctx.ui.notify(
				`🛡️ Access request from ${damagePreview(agent)}: ${damagePreview(request.rule)}\n   tool: ${damagePreview(request.tool)}\n   attempted: ${damagePreview(request.invocation, 200)}`,
				"warning",
			);
			try {
				const choice = await ctx.ui.select(
					`🛡️ ${damagePreview(agent)} requests access: ${damagePreview(pattern)}`,
					options,
					// Each subscriber has its own deadline. The earliest requester must
					// not time out the dialog while another live requester still needs it.
					{ timeout: 60_000, signal: waitSignal },
				);
				if (waitSignal.aborted || requestGeneration !== generation) { finishTrace({status:'cancelled'});return "deny"; }
				const selected = allowed.find((decision) => labels.get(decision) === choice) ?? "deny";
				finishTrace({status:choice===undefined?'cancelled':selected==='deny'?'denied':'allowed'});
				if (selected === "deny" && choice === labels.get("deny")) denyCache.add(cacheKey);
				return selected;
			} catch {
				finishTrace({status:'failed'});
				return "deny";
			}
		}, controller.signal).then(value=>value??'deny' as AccessDecisionChoice, ():AccessDecisionChoice=>'deny').finally(()=>finishQueue({status:'cancelled'}));
		const entry: PendingApproval = { controller, waiters: 0, promise: ask };
		pending.set(cacheKey, entry);
		void ask.finally(() => { if (pending.get(cacheKey) === entry) pending.delete(cacheKey); });
		return subscribe(entry, signal);
	};

 const machineDecision=async(request:AccessRequest,signal:AbortSignal)=>{
  const a=request.exactAction,identity=deps.taskIdentity?.();
  if(!deps.relay||!a||!identity||!request.accessEpoch||!deps.currentChild?.(request)||request.category==='zero_access'||denyCache.has(accessRequestCacheKey(request))||fileExemptionsFor(deps.getExemptionsFile()??undefined,request.agent).some(e=>e.pattern===request.pattern))return null;
  if(a.tool!==request.tool||a.category!==request.category||a.pattern!==request.pattern||!['bash','write','edit'].includes(a.tool)||typeof a.cwd!=='string'||createHash('sha256').update(JSON.stringify(a)).digest('hex')!==request.actionDigest)return null;
  const scopeSnapshot=JSON.stringify(fileExemptionsFor(deps.getExemptionsFile()??undefined,request.agent));
  const fresh=()=>JSON.stringify(fileExemptionsFor(deps.getExemptionsFile()??undefined,request.agent))===scopeSnapshot&&!signal.aborted&&deps.currentChild?.(request)===true&&createHash('sha256').update(JSON.stringify(request.exactAction)).digest('hex')===request.actionDigest&&JSON.stringify(deps.taskIdentity?.())===JSON.stringify(identity);
  const pending=deps.relay.open({taskId:identity.taskId,inputRevision:identity.inputRevision,operation:a.tool as 'bash'|'write'|'edit',target:createHash('sha256').update(JSON.stringify(a.input)).digest('hex'),cwd:a.cwd,actionId:request.msg_id,owner:request.agent,attempt:request.accessEpoch,requestContext:{source:'child_access',category:request.category,pattern:request.pattern,digest:request.actionDigest!,epoch:request.accessEpoch}},a.input,fresh,request.deadline!);
  if(!pending)return null;
  const local=new AbortController(),abort=()=>{local.abort();pending.cancel();};signal.addEventListener('abort',abort,{once:true});
  let localChoice:AccessDecisionChoice='deny';
  const ctx=deps.getContext();
  if(ctx?.hasUI){
   const choices:[AccessDecisionChoice,string][]=[['allow_once','Allow once'],...(request.category==='no_delete'?[]:[['allow_agent','Allow for this agent (this session)'],['allow_all','Allow for all agents (this session)']] as [AccessDecisionChoice,string][]),['deny','Deny (keep blocked)']];
   void askQueue.run(async waitSignal=>{
    if(!fresh()||waitSignal.aborted)return;
    const selected=await ctx.ui.select(`🛡️ ${damagePreview(request.agent)} requests access: ${damagePreview(request.pattern)}`,choices.map(c=>c[1]),{timeout:Math.max(1,request.deadline!-Date.now()),signal:waitSignal});
    if(local.signal.aborted||!fresh())return;
    const choice=choices.find(c=>c[1]===selected)?.[0];if(!choice){pending.cancel();return;}
    localChoice=choice;pending.human(choice==='deny'?'deny':'allow_once','local-ui');
   },local.signal).catch(()=>{});
  }
  try{
   const outcome=await pending.result;
   if(outcome.status!=='decided'||!fresh())return {decision:'deny' as const,terminal:outcome.status==='expired'?'expired' as const:outcome.status==='stale'?'stale' as const:'cancelled' as const,source:undefined,valid:()=>false,responseWritten:()=>{},failed:()=>{}};
   return {terminal:undefined,decision:outcome.source==='local_human'?localChoice:outcome.decision,source:outcome.source,outcome,permissionId:pending.id,valid:()=>outcome.decision==='deny'?fresh():pending.valid(),responseWritten:pending.responseWritten,failed:()=>pending.applied(false)};
  }finally{local.abort();signal.removeEventListener('abort',abort);}
 };

	return {
		async handle(socket: ReplySocket, request: AccessRequest): Promise<void> {
			if (!validRequest(request)) {
				respond(socket, request.msg_id, "deny");
				return;
			}
			const agent = (typeof request.agent === "string" && request.agent) || request.sender_session || "unknown-agent";
			// Bound legacy callers too. The timer covers queue time, not only UI time.
			if(request.accessEpoch&&deps.currentChild&&!deps.currentChild(request)){try{socket.end();}catch{}return;}
			const monotonicStarted = performance.now(), wallStarted = Date.now();
			const deadline = Math.min(request.deadline ?? Infinity, wallStarted + 60_000);
			if (deadline <= wallStarted) { respond(socket, request.msg_id, 'deny',{outcome:'expired'}); return; }
			const monotonicDeadline = monotonicStarted + deadline - wallStarted;
			const deadlineReached = () => Date.now() >= deadline || performance.now() >= monotonicDeadline;
			const controller = new AbortController();
			let timer: ReturnType<typeof setTimeout>;
			const expire = () => {
				if (controller.signal.aborted) return;
				// A timer may wake just before the wall-clock deadline. Keep the
				// original deadline rather than misclassifying that wake as cancel.
				// Wall-clock rollback must never extend the original elapsed budget.
				const remaining = Math.min(deadline - Date.now(), monotonicDeadline - performance.now());
				if (remaining > 0) { timer = setTimeout(expire, Math.max(1, Math.ceil(remaining))); return; }
				controller.abort();
			};
			timer = setTimeout(expire, Math.max(1, Math.ceil(monotonicDeadline - performance.now())));
			const disconnected = () => controller.abort('requester_disconnected');
			socket.on?.("close", disconnected);
			socket.on?.("error", disconnected);
			if (socket.destroyed) controller.abort();
            const scopeSnapshot=JSON.stringify(fileExemptionsFor(deps.getExemptionsFile()??undefined,request.agent));
			let decision: AccessDecisionChoice;
            let machine:Awaited<ReturnType<typeof machineDecision>>=null;
			try { machine=await machineDecision({...request,deadline},controller.signal);decision=machine?.decision??await decide({ ...request, deadline }, controller.signal).catch((): AccessDecisionChoice => "deny"); }
			finally {
				clearTimeout(timer);
				socket.removeListener?.("close", disconnected);
				socket.removeListener?.("error", disconnected);
			}
			if (socket.destroyed) return;
            if(JSON.stringify(fileExemptionsFor(deps.getExemptionsFile()??undefined,request.agent))!==scopeSnapshot){machine?.failed();respond(socket,request.msg_id,'deny',{outcome:'stale'});return;}
            if(machine&&!machine.valid()){respond(socket,request.msg_id,'deny',{outcome:machine.terminal??'stale'});return;}
			if (controller.signal.aborted || deadlineReached()) {
    if(controller.signal.reason==='requester_disconnected')return;
				respond(socket,request.msg_id,'deny',{outcome:deadlineReached()?'expired':'cancelled'});
				return;
			}
            const rejectExpired = () => {
                if (!deadlineReached()) return false;
                machine?.failed();
                respond(socket, request.msg_id, 'deny', {outcome:'expired'});
                return true;
            };
            if(decision==='deny'&&!machine&&!denyCache.has(accessRequestCacheKey(request))){respond(socket,request.msg_id,'deny',{outcome:'cancelled'});return;}
            if(machine?.outcome&&deps.appendPermissionLog){try{deps.appendPermissionLog({schema:'damage-permission-decision/v1',permissionId:machine.permissionId,actionDigest:request.actionDigest,...permissionAuditOutcome(machine.outcome)});}catch{machine.failed();respond(socket,request.msg_id,'deny',{outcome:'audit_failed'});return;}}
            if(JSON.stringify(fileExemptionsFor(deps.getExemptionsFile()??undefined,request.agent))!==scopeSnapshot){machine?.failed();respond(socket,request.msg_id,'deny',{outcome:'stale'});return;}
   try{deps.appendLog({action:`escalation_${decision}`,stage:'intent_before_scope_write',agent:damagePreview(agent),pattern:damagePreview(request.pattern),tool:damagePreview(request.tool),rule:damagePreview(request.rule),actionDigest:request.actionDigest??null,...(machine?.outcome?{permissionId:machine.permissionId,permissionOutcome:permissionAuditOutcome(machine.outcome)}:{}),decisionSource:machine?.source??'legacy_local_ui_or_existing_scope'});}catch{machine?.failed();respond(socket,request.msg_id,'deny',{outcome:'audit_failed'});return;}
            if (rejectExpired()) return;
			const exemptionsFile = deps.getExemptionsFile();
			if ((decision === "allow_agent" || decision === "allow_all") && exemptionsFile) {
				try {
					const exemption: Exemption = {
						pattern: request.pattern,
						scope: "session",
						agent: decision === "allow_agent" ? agent : undefined,
						grantedVia: "escalation",
						grantedAt: deps.now(),
					};
                    if (rejectExpired()) return;
                    appendExemptionToFile(exemptionsFile, exemption);
				} catch { /* allow-once semantics still hold via the reply */ }
			}
			try {
				deps.getContext()?.ui.notify(
					`🛡️ Access ${decision === "deny" ? "denied" : `granted (${decision.replace(/_/g, " ")})`}: ${damagePreview(request.pattern)} — ${damagePreview(agent)}`,
					decision === "deny" ? "warning" : "info",
				);
			} catch { /* ignore */ }
            if(machine?.source==='codex_machine'&&!machine.valid()){machine.failed();try{socket.end();}catch{}return;}
            if (rejectExpired()) return;
			const queued=respond(socket, request.msg_id, decision,{...(machine?.source?{decisionSource:machine.source}:{}),actionDigest:request.actionDigest});
            if(queued)machine?.responseWritten();
		},
		reset() {
			generation++;
			askQueue.reset();
			for (const entry of pending.values()) entry.controller.abort();
			denyCache.clear();
			pending.clear();
		},
	};
}
