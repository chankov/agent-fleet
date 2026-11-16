/** Import-free catalog assessment shared by MCP and notification callers.
 * Only bounded inert diagnostics are supported, not arbitrary getters/Proxies.
 * This is neither host attestation nor a grant/activation mechanism.
 */
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const legacyNotificationToolNames = ["fleet_discover", "fleet_binding_prepare", "fleet_binding_commit", "fleet_check_read", "fleet_observe", "fleet_overview", "fleet_resync", "fleet_watch", "fleet_instruction_prepare", "fleet_instruction_commit", "fleet_instruction_receipt", "fleet_answer_prepare", "fleet_answer_commit", "fleet_answer_receipt", "fleet_journal_upgrade_prepare", "fleet_journal_upgrade_commit", "fleet_diagnostics", "fleet_receipts", "fleet_legacy_history", "fleet_snapshot", "fleet_replay", "fleet_permissions", "fleet_permission_decide", "fleet_permission_receipt"];
const connectionTools=['fleet_connect_prepare','fleet_connect_commit','fleet_connection_status'];
const connectionNotificationToolNames=[...legacyNotificationToolNames,...connectionTools];
export const notificationToolNames=[...connectionNotificationToolNames,'fleet_response_read'];
/** Only the revision actually offered by Fleet's own MCP dispatcher/diagnostics.
 * SDK-supported revisions alone do not establish this server's protocol support.
 */
export const fleetCatalogProtocolVersions=Object.freeze(['2025-06-18'] as const);
const validToolName=(name:unknown):name is string=>typeof name==='string'&&name.length>0&&name.length<=128&&!/[^A-Za-z0-9._-]/.test(name);
/** Required subset, NOT source availability or host readiness.
 * Extra valid MCP names confer no rights and are never invoked here.
 * Explicit legacy 24/27 profiles are notification-only, not full-response support.
 */
export function assessLoadedFleetCatalog(observation:unknown,allowLegacy=false){
 const d=object(observation)?observation:{},tools=Array.isArray(d.tools)?d.tools:[];
 // Bound BEFORE materializing: even a huge sparse JS array must not be iterated.
 const bounded=Array.isArray(d.tools)&&tools.length<=128;
 const names=bounded?Array.from(tools,t=>object(t)&&Object.hasOwn(t,'name')?t.name:undefined):[];
 const valid=bounded&&names.every(validToolName)&&new Set(names).size===names.length;
 const expected=allowLegacy!==true||names.includes('fleet_response_read')?notificationToolNames:connectionTools.some(n=>names.includes(n))?connectionNotificationToolNames:legacyNotificationToolNames;
 const missing=expected.filter(n=>!names.includes(n));
 const unexpected=bounded?names.filter(n=>!validToolName(n)).map(()=> 'unexpected_tool_entry'):tools.length?['unexpected_tool_entry']:[];
 const ready=valid&&Object.hasOwn(d,'identity')&&d.identity==='host_context_validated'&&Object.hasOwn(d,'protocolVersion')&&fleetCatalogProtocolVersions.some(v=>v===d.protocolVersion)&&missing.length===0;
 return {ready,loadedCount:tools.length,sourceCount:expected.length,missing,unexpected,action:ready?'none':'operator_reload_required_not_performed'};
}
