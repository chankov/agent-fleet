/** JSON-serializable CLI contract. Help and argument validation derive from this source. */
interface Parameter {type:'string'|'integer';description:string;minimum?:number;maximum?:number;default?:number;pattern?:string;maxLength?:number;}
export type Requirement='none'|'identity'|'binding'|'report'|'sources'|'instruction'|'questions';
export interface Operation {
 name:string;description:string;usage:string;
 inputSchema:{type:'object';properties:Record<string,Parameter>;required:string[];additionalProperties:false};
 effects:{remote:'none'|'read'|'instruction'|'answer';local:'none'|'binding'|'journal'};
 requirements:Requirement[];limitations:string[];
}
export interface Availability {status:'available'|'unsupported'|'unavailable';reason:string;}
const string=(description:string):Parameter=>({type:'string',description});
const id:Parameter={...string('Stable request/question identifier; never reuse for a different payload or target.'),pattern:'^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$'};
const project:Parameter={...string('Explicit coms project; never inferred only from cwd.')};
const stateDir=string('Optional private 0700 directory; defaults to CODEX_HOME/fleet-client.');
function operation(name:string,description:string,properties:Record<string,Parameter>,required:string[],requirements:Requirement[],remote:Operation['effects']['remote']='none',local:Operation['effects']['local']='none',limitations:string[]=[]):Operation {
 const args=Object.entries(properties).map(([key,p])=>{
  const value=p.type==='integer'?`${p.minimum}..${p.maximum}`:key;
  const flag=`--${key} <${value}>`;return required.includes(key)?flag:`[${flag}]`;
 });
 return {name,description,usage:[name,...args].join(' '),inputSchema:{type:'object',properties:{...properties,'state-dir':stateDir},required,additionalProperties:false},effects:{remote,local},requirements,limitations};
}
const sources=['Bounded source coverage; unavailable and partial sources remain explicit.','Question reads cover at most four pages; follow nextCursor with questions --after.'];
const answers=['Requires an explicit human response to the exact pending owner/question/tool call.','Pi validates flags and arbitrates the first valid answer. Availability does not prove a particular question is pending.','Receipt persisted before delivery; unknown outcomes must not be retried automatically.'];
const operations:Operation[]=[
 operation('sessions','Discover existing Pi sessions in an explicit project.',{project},['project'],['none']),
 operation('select','Bind this conversation to a fresh, unambiguous project/peer identity.',{project,peer:string('Exact Pi peer name.')},['project','peer'],['identity'],'none','binding',['Requested project/peer is validated at selection time.']),
 operation('status','Read selection/registry presence and separate question state.',{},[],['identity'],'read','journal',['Registry presence is not execution or transport readiness.']),
 operation('activity','Read a fresh bounded activity, monitor and question snapshot.',{},[],['sources'],'read','journal',sources),
 operation('summary','Read fresh bounded source evidence for a conversational summary.',{},[],['sources'],'read','journal',sources),
 operation('resync','Advance source cursors and recover exactly correlated receipts.',{},[],['sources'],'read','journal',sources),
 operation('replay','Read the last stored report, explicitly marked historical.',{},[],['report'],'none','none',['Requires a saved report for this exact binding; does not prove current question state.']),
 operation('receipts','Read recorded instruction and answer outcomes, including offline.',{},[],['binding']),
 operation('send','Submit a human-authorized Pi follow-up instruction.',{id,'text-file':string('Owned regular non-symlink 0600 UTF-8 file, 1–16000 bytes.'),'wait-ms':{type:'integer',description:'Bounded reply wait in milliseconds.',minimum:100,maximum:60000,default:1000}},['id','text-file'],['instruction'],'instruction','journal',['Requires a unique visible herdr Pi pane and correlated coms ping.','Busy Hub instructions queue; immediate child steering is not guaranteed.','Submitted/queued is not completion. Duplicate IDs never cause another send; unknown requires inspection.']),
 operation('watch','Emit bounded NDJSON source snapshots while the client is active.',{seconds:{type:'integer',description:'Active observation window in seconds.',minimum:1,maximum:60}},['seconds'],['sources'],'read','journal',[...sources,'No idle wake or model polling; ending watch does not stop Pi. Slow source calls may extend a sample until timeout.']),
 operation('doctor','Read local dependency versions and selection diagnostics.',{},[],['none']),
 operation('detach','Remove only this conversation selection; leave Pi running.',{},[],['identity'],'none','binding'),
 operation('questions','Read one page of addressed pending questions and terminal IDs.',{after:{...id,description:'Question cursor from nextCursor.'}},[],['questions'],'read','journal',['Requires a compatible Pi wrapper; unsupported is not an empty list.','Pages are bounded to 32 KiB; terminal history is bounded.']),
 operation('answer','Submit an explicit structured human answer to one question.',{id,question:id,'answer-file':string('Owned regular non-symlink 0600 JSON file, at most 16000 bytes; selection or freeform matching question flags.')},['id','question','answer-file'],['questions'],'answer','journal',answers),
 operation('cancel-question','Submit the human\'s explicit refusal for one question.',{id,question:id},['id','question'],['questions'],'answer','journal',answers),
 operation('describe','Describe the contract and check current prerequisites without executing mutations.',{},[],['none'],'read','none',['Point-in-time capability check; operations revalidate their own prerequisites.','Does not send instructions, answer questions or update observations/cursors/receipts.']),
];
export function clientCatalog() {
 return structuredClone({schemaVersion:1,client:'fleet-session-client',operations,usage:operations.map(o=>o.usage),
  options:'--state-dir <private-directory>',identity:'CODEX_THREAD_ID from execution environment',
  scope:'Existing Pi; active bounded reads, no idle wake or automatic human choice.',
  availabilitySemantics:'Available means observed prerequisites, not authorization or guaranteed future delivery. Unavailable means missing/unverifiable prerequisites; unsupported means a verified protocol/runtime limitation.'});
}
export function parseClientArguments(argv:string[]) {
 const [command,...args]=argv;const op=operations.find(o=>o.name===command);
 if(!op)throw Error('Unknown command; use --help');
 const flags:Record<string,string>={};
 for(let i=0;i<args.length;i+=2){
  const key=args[i].startsWith('--')?args[i].slice(2):'';const value=args[i+1];
  if(!Object.hasOwn(op.inputSchema.properties,key)||flags[key]!==undefined||!value||value.startsWith('--'))throw Error('Invalid or duplicate command option');
  const p=op.inputSchema.properties[key];
  if(p.type==='integer'&&(!Number.isInteger(Number(value))||Number(value)<p.minimum!||Number(value)>p.maximum!))throw Error(`--${key} must be ${p.minimum}–${p.maximum}`);
  if(p.pattern&&!new RegExp(p.pattern).test(value))throw Error(`Invalid --${key}`);
  flags[key]=value;
 }
 for(const key of op.inputSchema.required)if(!flags[key])throw Error(`--${key} is required`);
 for(const [key,p] of Object.entries(op.inputSchema.properties))if(flags[key]===undefined&&p.default!==undefined)flags[key]=String(p.default);
 return {command,flags};
}
