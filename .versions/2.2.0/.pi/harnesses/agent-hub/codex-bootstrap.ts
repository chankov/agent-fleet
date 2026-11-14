import type {ExtensionAPI,ExtensionContext} from '@mariozechner/pi-coding-agent';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {AutomaticDesktopDiscovery} from '../../agent-fleet/scripts/lib/codex-desktop-discovery.ts';
import {FleetCodexBootstrap,type BootstrapChatRow} from '../../agent-fleet/scripts/lib/fleet-codex-bootstrap.ts';
import {FleetCodexNotificationRuntime,readNotificationConfiguration,notificationConfigurationUnchanged,notificationPreview,renewNotificationConfiguration} from '../../agent-fleet/scripts/lib/fleet-codex-event-runtime.ts';
import {AllowedSessionsStore} from '../../agent-fleet/scripts/lib/fleet-codex-allowlist-store.ts';
import type {NotificationConfig} from '../lib/fleet-notification-validation.ts';
import {targetKey,validInstructionTarget} from '../lib/fleet-notification-validation.ts';
import {FleetConnectionControl,connectionLines,connectionNamespaces} from '../lib/fleet-connection-control.ts';
import {namespaceKey} from '../lib/fleet-bootstrap-channel.ts';
import {safeTerminalText} from '../lib/fleet-strip-view.ts';
import type {BootstrapNamespace} from '../lib/fleet-notification-bootstrap.ts';
const clean=(v:unknown)=>safeTerminalText(String(v)).replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g,'?');
// Only exact internal codes are public. Exception text/paths/stacks stay private.
const preflightFailures=new Set([
 'desktop_pid_invalid','desktop_preflight_inputs','desktop_preflight_options','desktop_preflight_pid',
 'desktop_preflight_cancelled_or_overdue','desktop_preflight_limit','desktop_preflight_process_owner',
 'desktop_preflight_process_invalid','desktop_preflight_executable_unavailable','desktop_preflight_executable_unsafe',
 'desktop_preflight_executable_changed','desktop_preflight_namespace','desktop_preflight_root_unsafe',
 'desktop_preflight_not_confirmed','desktop_preflight_changed',
 'native_presence_required','native_presence_stale','native_presence_changed','native_presence_invalid',
 'native_presence_limit','native_presence_cancelled','native_presence_request_capacity','native_presence_path',
 'native_writer_unavailable','owner_unavailable','catalog_not_ready',
 'native_pi_ui_unavailable','native_pi_confirmation_busy','bootstrap_cancelled',
 'bootstrap_directory_unsafe','bootstrap_file_invalid','bootstrap_file_limit','bootstrap_file_unsafe',
 'bootstrap_file_changed','bootstrap_file_cancelled','bootstrap_file_publication_unknown','bootstrap_file_cleanup_unsafe',
]);
const preflightIoFailures=new Set(['EACCES','EPERM','ENOENT','ENOTDIR','ELOOP','EIO','ENOSPC','EROFS','EMFILE','ENFILE','EEXIST']);
function preflightFailureCode(error:unknown):string{
 if(!(error instanceof Error))return 'preflight_failed';
 const message=Object.getOwnPropertyDescriptor(error,'message')?.value;
 if(typeof message==='string'&&preflightFailures.has(message))return message;
 const code=Object.getOwnPropertyDescriptor(error,'code')?.value;
 return typeof code==='string'&&preflightIoFailures.has(code)?'preflight_io_'+code:'preflight_failed';
}
/** Composition boundary. Native confirmation is never a dashboard re-press or a
 * model-supplied flag. Rendering/status only reads detached cached view data. */
export function createCodexBootstrapControls(pi:ExtensionAPI,options:{owner:()=>unknown;context:()=>ExtensionContext|null;changed:()=>void}){
 const policyRoot=process.env.AF_CODEX_POLICY_ROOT??join(homedir(),'.codex/agent-fleet/state/fleet-native'),namespace={hostProfile:process.env.AF_CODEX_HOST_PROFILE??'desktop',principal:process.env.AF_CODEX_PRINCIPAL??'local-user'};
 let manual:FleetCodexNotificationRuntime|undefined,knownManual:{config:NotificationConfig;path:string}|undefined,renew:((until:number)=>unknown)|undefined,confirmationBusy=false;
 let timer:ReturnType<typeof setInterval>|undefined,refreshing=false,lastRefresh=0,stopped=false,cached:BootstrapChatRow[]=[],cachedLegacy:ReturnType<FleetConnectionControl['rows']>=[];
 const owner=()=>{const value=options.owner();return validInstructionTarget(value)?value:null;};
 const nativeConfirm=async(title:string,body:string,signal:AbortSignal)=>{
  const ctx=options.context();if(!ctx?.hasUI)throw Error('native_pi_ui_unavailable');if(confirmationBusy)throw Error('native_pi_confirmation_busy');if(signal.aborted)throw Error('bootstrap_cancelled');confirmationBusy=true;
  try{const answer=await ctx.ui.confirm(title,body.split('\n').map(clean).join('\n'),{signal});if(signal.aborted)throw Error('bootstrap_cancelled');return answer===true;}finally{confirmationBusy=false;}
 };
 let control:FleetConnectionControl;
 const discovery=new AutomaticDesktopDiscovery({codexHome:process.env.CODEX_HOME??join(homedir(),'.codex')});
 const backend=new FleetCodexBootstrap({policyRoot,namespace,owner,discoverDesktop:signal=>discovery.discover(signal),
  presence:(c,lease)=>lease?control.bootstrapChannel.leaseObservation(c):control.bootstrapChannel.observation(c),writeRights:(r,s)=>control.writeBootstrapRights(r,s),
  confirm:(review,signal)=>nativeConfirm('Включване / reconnect на Codex известия',[
   `Чат: ${review.scope.namespace.hostProfile}/${review.scope.namespace.principal}/${review.scope.namespace.threadId}`,
   `Fleet owner: ${targetKey(review.scope.owner)}`,`Native MCP: ${review.scope.binding.hostInstance}`,`Права: ${review.scope.rights.join(' + ')}; общ срок: ${new Date(review.scope.until).toISOString()}`,
   `Очаквана policy revision: ${review.previousRights.revision}`,`Daemon: ${review.compatibility.context.daemonVersion}; Desktop: ${review.compatibility.context.desktopVersion}`,
   ...(review.desktopMapping?['Новият Desktop mapping е установен автоматично — няма ръчно попълване.',`Намерен Codex Desktop: версия ${review.desktopMapping.desktopVersion}; процес ${review.desktopMapping.desktop.pid}; ${review.desktopMapping.desktop.executable}`, 'С това решение одобряваш връзката на открития Desktop с този чат. Mapping се записва след потвърждението, преди Codex правата.']:[]),
   `Съвместимост: ${review.compatibility.level}; fingerprint: ${'fingerprint'in review.compatibility?review.compatibility.fingerprint:'няма'}; ${review.warning??'няма квалифициран fingerprint'}`,
   'След потвърждението се премахва груповият запис само от transcript файла на този чат и собствените му директории под Codex sessions, ако е нужно; без рекурсия или промяна на съдържанието.',
   'Codex (не AF) записва точно тези права. След това се изпраща един nonce probe, който може да събуди модела и да изразходва контекст/токени.',
   'В рамките на същите права/owner/срок разрешаваш и до 4 автоматични probe проби само след засечена смяна на daemon контекст и доказано същия contract fingerprint. Няма периодични проби; непроверен contract, нов fingerprint или неизвестен резултат оставят runtime спрян.',
   'Известията се активират само след нов точен terminal ACK. ACK на queue не доказва доставка. Approve не означава автоматично одобрение на бъдещи разрешения.',
   'Необходимо е старите policy writers да са спрени; неизвестни/прекъснати резултати не се повтарят автоматично. Потвърждаваш ли?'
  ].join('\n'),signal),
  confirmPreflight:(review,signal)=>nativeConfirm('Еднократен Desktop identity preflight — без права и queue',[
   'Това е отделна ръчна асоциация на реален Desktop процес, версия, чат и действително зареден каталог — не активация и не съгласие за grants.',
   JSON.stringify(review,null,2),
   'Провери PID/start time/executable SHA256, реалната версия от Desktop и че точно този чат е заредил Fleet MCP инструментите (включително fleet_response_read). SDK clientInfo/UA сами не доказват това.',
   'Записва се само частна mapping policy. Потвърждаваш ли тези лично проверени факти?'
  ].join('\n'),signal),
  legacy:()=>knownManual?{config:knownManual.config,runtime:manual,release:()=>{manual=undefined;renew=undefined;}}:undefined,
 });
 control=new FleetConnectionControl({owner,bootstrap:backend.coordinator,bootstrapStatus:c=>{const row=backend.rows().find(r=>namespaceKey(r.namespace)===namespaceKey(c));return row?{enabled:row.notification==='enabled',reason:row.reason??row.notification,expiresAt:row.expiresAt,compatibility:row.compatibility,lastNotification:row.lastNotification,events:['message','question','permission']}:{enabled:false,reason:'cached_runtime_unavailable'};},
  session:()=>manual?{status:()=>manual!.status(),renewUntil:until=>{if(!renew)throw Error('renewal_unavailable');return renew(until);}}:undefined,defaultNamespace:namespace,
  listNamespaces:async()=>(await connectionNamespaces(policyRoot)).filter(c=>c.hostProfile===namespace.hostProfile&&c.principal===namespace.principal),
  readRights:async c=>{const current=owner();if(!current)return {rights:[],status:'owner_unavailable'};try{const state=await new AllowedSessionsStore(policyRoot,c).open(),binding=state.bindings.find(b=>b.target.project===current.project&&b.target.peer===current.peer);return binding?{rights:[...binding.rights],expiresAt:binding.expiresAt,status:targetKey(binding.target)===targetKey(current)?binding.status:'target_changed',revision:state.revision}:{rights:[],status:'not_connected',revision:state.revision};}catch{return {rights:[],status:'rights_unavailable'};}},
 });
 async function refresh(force=false){if(stopped||refreshing||!force&&Date.now()-lastRefresh<2000)return;lastRefresh=Date.now();refreshing=true;
  try{await Promise.all([control.refresh(),backend.refreshCached()]);cachedLegacy=control.rows();const rows=backend.rows(),keys=new Set(rows.map(r=>namespaceKey(r.namespace)));
   for(const old of cachedLegacy){const c={...namespace,threadId:old.threadId};if(!keys.has(namespaceKey(c)))rows.push({namespace:c,producer:'missing',rights:old.rights,rightsStatus:old.rightsReason,expiresAt:old.rightsExpiresAt??undefined,notification:old.notifications.enabled?'enabled':'disabled',reason:String(old.notifications.reason??'native_presence_required'),lastNotification:'lastNotification'in old.notifications?old.notifications.lastNotification:undefined});}
   cached=structuredClone(rows);
  }catch{}finally{refreshing=false;options.changed();}
 }
 const rows=()=>structuredClone(cached);
 async function pick(ctx:ExtensionContext){await refresh(true);const items=rows();if(!items.length){ctx.ui.notify('Няма native presence. В точния Codex чат извикай без grants fleet_diagnostics; ако се налага, презареди обновения MCP. Няма автоматично resume/start.','warning');return;}
  const labels=items.map(r=>`${r.namespace.hostProfile}/${r.namespace.principal}/${r.namespace.threadId} · ${r.producer}`),selected=await ctx.ui.select('Избери Codex чат',labels);return selected===undefined?undefined:items[labels.indexOf(selected)]?.namespace;
 }
 async function preflight(c:BootstrapNamespace,ctx:ExtensionContext){
  const pid=await ctx.ui.input('Изрично избран PID на реалния работещ Desktop (без процесно сканиране)');if(pid===undefined)return;if(!/^[1-9][0-9]{0,9}$/.test(pid))throw Error('desktop_pid_invalid');
  const desktopVersion=await ctx.ui.input('Лично проверена реална Desktop версия (не SDK/clientInfo)');if(desktopVersion===undefined)return;
  const socketPath=await ctx.ui.input('Абсолютен UNIX socket на вече работещия daemon — няма да го стартираме');if(socketPath===undefined)return;
  const codexHome=await ctx.ui.input('Каноничен абсолютен Codex home за този профил');if(codexHome===undefined)return;
  const binary=await ctx.ui.input('Доверен абсолютен matching CLI за --version/offline schema export (празно = contract_unverified)');if(binary===undefined)return;
  await backend.capturePreflight(c,{desktopPid:Number(pid),desktopVersion,socketPath,codexHome,...(binary?{binaryPath:binary}:{})});ctx.ui.notify('Desktop mapping policy е записана. Няма grants, queue probe или активация; readiness/qualification още не е доказана.','info');await refresh(true);
 }
 async function action(kind:'enable'|'disable'|'preflight',c:BootstrapNamespace,ctx:ExtensionContext){
  try{if(kind==='preflight')return await preflight(c,ctx);if(kind==='disable'){await backend.disable(c);ctx.ui.notify('Известията за този чат са спрени; Codex правата не са променени.','info');}else{const result=await backend.enable(c);ctx.ui.notify(clean(JSON.stringify(result)),result.activation==='enabled'?'info':'warning');}await refresh(true);}catch(error){
   const message=kind==='preflight'
    ?`Desktop preflight: ${preflightFailureCode(error)}. Записът не е потвърден. Провери mapping файла и cached статуса; не повтаряй сляпо.`
    :'Операцията е отказана или резултатът е неизвестен. Провери cached статуса/частния journal; не повтаряй сляпо. При липсващи/двусмислени Desktop факти включването спира; не повтаряй сляпо.';
   ctx.ui.notify(message,'error');
  }
 }
 pi.registerCommand('af-codex-events',{description:'connect|preflight|status|disable-chat или legacy prepare|enable <private config.json>|disable; без автоматични grants/start',handler:async(args:string,ctx:ExtensionContext)=>{
  let started:FleetCodexNotificationRuntime|undefined;
  try{const split=args.trim().indexOf(' '),operation=split<0?args.trim():args.trim().slice(0,split),path=split<0?'':args.trim().slice(split+1).trim();
   if(operation==='status'){ctx.ui.notify(clean(JSON.stringify(rows())), 'info');return;}
   if(['connect','preflight','disable-chat'].includes(operation)){const c=await pick(ctx);if(c)await action(operation==='connect'?'enable':operation==='preflight'?'preflight':'disable',c,ctx);return;}
   if(operation==='disable'){manual?.stop();manual=undefined;renew=undefined;ctx.ui.notify('Legacy runtime е спрян; няма промяна в grants. За bootstrap чат използвай disable-chat.','info');return;}
   if(!['prepare','enable'].includes(operation)||!path)throw Error('notification_command_invalid');
   const config=readNotificationConfiguration(path),preview=notificationPreview(config,owner());if(operation==='prepare'||!preview.ready){ctx.ui.notify(clean(JSON.stringify(preview)),preview.ready?'info':'warning');return;}if(manual||backend.hasRuntimeFor(config.approval.binding.threadId))throw Error('notification_runtime_already_running');
   const runtime=new FleetCodexNotificationRuntime(config,()=>notificationConfigurationUnchanged(path,config)?owner():null);started=runtime;manual=runtime;await runtime.start();knownManual={config,path};renew=until=>runtime.renewUntil(until,()=>{const next=renewNotificationConfiguration(path,config,until);config.approval.confirmedUntil=next.approval.confirmedUntil;});await refresh(true);ctx.ui.notify('Legacy ingress е включен изрично; queue ACK не доказва model delivery, няма нови approve grants.','info');
  }catch{if(started){started.stop();if(manual===started)manual=undefined;}ctx.ui.notify('Операцията е отказана/неизвестна; провери private journal и не replay-вай.','error');}
 }});
 pi.on('session_start',async()=>{if(stopped)return;if(timer)clearInterval(timer);timer=setInterval(()=>{backend.checkContexts();void refresh();},2000);timer.unref?.();await refresh(true);});
 pi.on('session_shutdown',async()=>{stopped=true;clearInterval(timer);backend.stop();control.stop();manual?.stop();manual=undefined;});
 return {control,backend,refresh:()=>refresh(),rows,lines:()=>connectionLines(cachedLegacy),action,resetSession:()=>{backend.reset();control.bootstrapChannel.reset();manual?.stop();manual=undefined;renew=undefined;cached=[];cachedLegacy=[];}};
}
