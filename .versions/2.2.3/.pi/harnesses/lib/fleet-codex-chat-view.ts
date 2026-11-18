import type {BootstrapChatRow} from '../../agent-fleet/scripts/lib/fleet-codex-bootstrap.ts';
import type {BootstrapNamespace} from './fleet-notification-bootstrap.ts';
import {namespaceKey} from './fleet-codex-namespace.ts';
import {safeTerminalText} from './fleet-strip-view.ts';
export type ChatView={selected?:string;detail:boolean;offset:number};
export type ChatIntent='back'|'presence_required'|{action:'enable'|'disable'|'preflight';namespace:BootstrapNamespace}|null;
const safe=(v:unknown)=>safeTerminalText(String(v)).replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g,'?');
function date(value:number|undefined){try{return value===undefined?'unknown':new Date(value).toISOString();}catch{return 'unreliable';}}
export function selectedChat(state:ChatView,rows:readonly BootstrapChatRow[]){const row=rows.find(r=>namespaceKey(r.namespace)===state.selected)??rows[0];state.selected=row?namespaceKey(row.namespace):undefined;return row;}
/** Intents only. This leaf has no UI confirmation, IO, prepare, commit or probe. */
export function chatTransition(input:string,state:ChatView,rows:readonly BootstrapChatRow[]):ChatIntent{
 const row=selectedChat(state,rows),index=row?rows.indexOf(row):0;
 if(input==='\u001b'||input==='q'){if(state.detail){state.detail=false;state.offset=0;return null;}return 'back';}
 if(input==='\r'||input==='\n'){state.detail=!state.detail;state.offset=0;return null;}
 if(input==='e'||input==='d'||input==='p'){
  if(!row)return 'presence_required';if(input!=='d'&&row.producer!=='fresh')return 'presence_required';return {action:input==='e'?'enable':input==='d'?'disable':'preflight',namespace:structuredClone(row.namespace)};
 }
 if(state.detail){if(input==='\u001b[A'||input==='k')state.offset=Math.max(0,state.offset-1);if(input==='\u001b[B'||input==='j')state.offset++;if(input==='\u001b[5~')state.offset=Math.max(0,state.offset-10);if(input==='\u001b[6~')state.offset+=10;if(input==='\u001b[H')state.offset=0;return null;}
 const next=input==='\u001b[A'||input==='k'?Math.max(0,index-1):input==='\u001b[B'||input==='j'?Math.min(rows.length-1,index+1):input==='\u001b[H'?0:input==='\u001b[F'?rows.length-1:index;
 if(rows[next])state.selected=namespaceKey(rows[next].namespace);return null;
}
const stageLabels:Record<string,string>={inspecting:'Checking compatibility',prepared:'Ready for Pi confirmation',confirming:'Waiting for Pi approval',writing_rights:'Writing approved rights',probing:'Preparing delivery probe',queue_submission:'Submitting probe to queue',waiting_ack:'Waiting for terminal ACK',validating_ack:'Validating ACK and unloaded state',activating:'Activating notifications',enabled:'Bootstrap completed',cancelled:'Cancelled',blocked:'Blocked',rejected:'Rejected',unknown:'Outcome unknown; do not replay',expired:'Expired',disabled:'Disabled'};
function diagnosticLines(row:BootstrapChatRow){
 const d=row.diagnostic,history=row.history;
 const lines=d?[`Connection stage: ${stageLabels[d.stage]??d.stage}; attempt ${d.attemptId}`,`Stage since: ${date(d.at)}${d.deadline===undefined?'':`; deadline ${date(d.deadline)}; ${Math.max(0,Math.ceil((d.deadline-Date.now())/1000))}s remaining`}`,...(d.reason?[`Failure: ${d.reason}`]:[])]:['Connection stage: no current attempt evidence'];
 lines.push(`Historical only — diagnostic history: ${history?.status??'missing'}; never restores rights or activation`);
 for(const attempt of (history?.attempts??[]).slice(-5).reverse()){
  lines.push(`Attempt ${attempt.attemptId} — ${attempt.owner.project}/${attempt.owner.peer} (${attempt.owner.sessionId})`);
  for(const step of attempt.transitions)lines.push(`  ${date(step.at)} ${stageLabels[step.stage]??step.stage}${step.reason?' — '+step.reason:''}`);
 }
 return lines;
}
export function chatLines(state:ChatView,rows:readonly BootstrapChatRow[]):string[]{
 const row=selectedChat(state,rows);
 if(!row)return ['No native Codex presence found.','Call fleet_diagnostics without grants in the exact Codex chat.','If needed, reload the updated MCP. We do not start the daemon or resume a chat.','Read-only metadata does not prove Desktop/catalog/no-load capability.'];
 if(!state.detail)return rows.map(r=>`${namespaceKey(r.namespace)===state.selected?'›':' '} ${r.namespace.hostProfile}/${r.namespace.principal}/${r.namespace.threadId} · ${r.producer} · ${r.notification}`).map(safe);
 const last=row.lastNotification as Record<string,unknown>|undefined;
 return [
  `Chat ${row.namespace.hostProfile}/${row.namespace.principal}/${row.namespace.threadId}`,`Native producer: ${row.producer}; MCP instance: ${row.hostInstance??'unknown'}`,
  `SDK observation (not Desktop version/identity): ${row.clientInfo?.name??'unknown'} / ${row.clientInfo?.version??'unknown'}`,
  `Rights: ${row.rights.join('+')||'none/unknown'}; ${row.rightsStatus}; expires ${date(row.expiresAt)}`,
  `Notifications: ${row.notification}; ${row.reason??''}; bootstrap ${row.proposalState??'none'}`,
  ...diagnosticLines(row),
  `Compatibility: ${row.compatibility??'unverified'}; not a production qualification`,
  `Last checked versions: daemon ${row.daemonVersion??'?'} / Desktop ${row.desktopVersion??'?'}`,
  `Expected daemon socket epoch: ${row.socketEpoch??'unknown'}`,`Binding epoch: ${row.bindingEpoch??'none'}`,
  `Last probe: ${row.lastProbe?row.lastProbe.id+' / '+row.lastProbe.receiptId:'no proven ACK'}`,
  `Last notification: ${last?.kind??'none'} / ${last?.stage??'?'} / queue ${last?.queueStatus??'unknown'}`,
  'A queue ACK does not prove the model read it. Model delivery stays unknown without separate proof.',
  'e: enable / explicit reconnect (one native Pi confirmation + one probe)',
  'd: disable notifications; does not revoke/renew Codex rights',
  'p: separate identity preflight; grants no rights and does not activate',
  ...(row.producer!=='fresh'?['No unambiguous fresh presence. Refresh the exact Codex MCP context; there is no automatic retry/resume.']:[]),
 ].map(safe);
}
