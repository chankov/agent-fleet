import type {BootstrapChatRow} from '../../agent-fleet/scripts/lib/fleet-codex-bootstrap.ts';
import type {BootstrapNamespace} from './fleet-notification-bootstrap.ts';
import {namespaceKey} from './fleet-codex-namespace.ts';
import {safeTerminalText} from './fleet-strip-view.ts';
export type ChatView={selected?:string;detail:boolean;offset:number};
export type ChatIntent='back'|'presence_required'|{action:'enable'|'disable'|'preflight';namespace:BootstrapNamespace}|null;
const safe=(v:unknown)=>safeTerminalText(String(v)).replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g,'?');
function date(value:number|undefined){try{return value===undefined?'неизвестен':new Date(value).toISOString();}catch{return 'недостоверен';}}
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
export function chatLines(state:ChatView,rows:readonly BootstrapChatRow[]):string[]{
 const row=selectedChat(state,rows);
 if(!row)return ['Няма открита native Codex presence.','В точния Codex чат извикай fleet_diagnostics без grants.','Ако е нужно, презареди обновения MCP. Не стартираме daemon и не resume-ваме чат.','Read-only metadata не доказва Desktop/каталог/no-load capability.'];
 if(!state.detail)return rows.map(r=>`${namespaceKey(r.namespace)===state.selected?'›':' '} ${r.namespace.hostProfile}/${r.namespace.principal}/${r.namespace.threadId} · ${r.producer} · ${r.notification}`).map(safe);
 const last=row.lastNotification as Record<string,unknown>|undefined;
 return [
  `Чат ${row.namespace.hostProfile}/${row.namespace.principal}/${row.namespace.threadId}`,`Native producer: ${row.producer}; MCP instance: ${row.hostInstance??'неизвестен'}`,
  `SDK observation (не Desktop версия/identity): ${row.clientInfo?.name??'неизвестен'} / ${row.clientInfo?.version??'неизвестна'}`,
  `Права: ${row.rights.join('+')||'няма/неизвестни'}; ${row.rightsStatus}; общ срок ${date(row.expiresAt)}`,
  `Известия: ${row.notification}; ${row.reason??''}; bootstrap ${row.proposalState??'няма'}`,
  `Съвместимост: ${row.compatibility??'непроверена'}; не е production qualification`,
  `Последно проверени версии: daemon ${row.daemonVersion??'?'} / Desktop ${row.desktopVersion??'?'}`,
  `Очакван daemon socket epoch: ${row.socketEpoch??'неизвестен'}`,`Binding epoch: ${row.bindingEpoch??'няма'}`,
  `Последен probe: ${row.lastProbe?row.lastProbe.id+' / '+row.lastProbe.receiptId:'няма доказан ACK'}`,
  `Последно известие: ${last?.kind??'няма'} / ${last?.stage??'?'} / queue ${last?.queueStatus??'неизвестно'}`,
  'Queue ACK не доказва прочитане от модела. Model delivery остава неизвестна без отделно доказателство.',
  'e: включи / изричен reconnect (едно native Pi потвърждение + един probe)',
  'd: изключи известията; не отменя/подновява Codex права',
  'p: отделен identity preflight; не дава права и не активира',
  ...(row.producer!=='fresh'?['Липсва еднозначна прясна presence. Обнови точния Codex MCP контекст; няма автоматичен retry/resume.']:[]),
 ].map(safe);
}
