import {basename,dirname,isAbsolute,relative,resolve} from 'node:path';
import {lstatSync,readdirSync,realpathSync} from 'node:fs';
import {checkedSourcePath} from '../../lib/safe-source-read.js';
import {exportPathAllowed} from '../agentic-sources.ts';
export const PINNED_PI_VERSION='0.84.2';
export interface CandidateSet {paths:string[];discoveryComplete:boolean;remaining:0|'unknown';reason?:string;hidden?:number;excluded?:number}
const refused=(reason:string):CandidateSet=>({paths:[],discoveryComplete:false,remaining:'unknown',reason});
export function canonicalCandidate(root:string,path:string,include:readonly string[]):string|undefined {
 try{
  const full=checkedSourcePath(root,resolve(root,path)),rel=relative(realpathSync(root),full).split('\\').join('/');
  if(!lstatSync(full).isFile()||!exportPathAllowed(rel,include))return;
  return rel;
 }catch{return;}
}
function unambiguous(full:string,grep=false){
 // Pi's fd formatter trims whitespace and newline-delimits names. Never guess their identity.
 return !readdirSync(dirname(full)).some(n=>/[\x00-\x1f\x7f]/.test(n)||n.trim()!==n||grep&&(n.includes(':')||/-\d+-/.test(n)));
}
export function adaptDiscovery(options:{tool:string;args:Record<string,unknown>;result:any;cwd:string;root:string;include:readonly string[];piVersion?:string}):CandidateSet {
 const {tool,args,result,root,include}=options;
 if(options.piVersion!==undefined&&options.piVersion!==PINNED_PI_VERSION)return refused('unsupported_pi_version');
 if(result?.isError)return refused('tool_error');
 if(!['find','ls','grep','filesystem'].includes(tool))return refused('unsupported_tool');
 let search:string;
 try{
  search=resolve(options.cwd,typeof args.path==='string'?args.path:'.');
  if(search!==realpathSync(root))checkedSourcePath(root,search);
  const rel=relative(realpathSync(root),search);if(isAbsolute(rel)||rel==='..'||rel.startsWith('../'))return refused('outside_workspace');
 }catch{return refused('invalid_search_root');}
 let complete=true,excluded=0;const candidates:string[]=[];
 const add=(path:string)=>{const candidate=canonicalCandidate(root,path,include);if(candidate)candidates.push(candidate);else {try{if(lstatSync(checkedSourcePath(root,path)).isFile())excluded++;}catch{}}};
 if(tool==='filesystem'){
  if(args.operation!=='inventory')return refused('unsupported_operation');
  const value=result?.details?.result;
  if(!value||value.root!==search||!Array.isArray(value.entries)||typeof value.truncated!=='boolean'||!Number.isSafeInteger(value.totalEntries))return refused('unknown_shape');
  complete=!value.truncated;
  for(const entry of value.entries){
   if(typeof entry.name!=='string'||entry.name.includes('/')||/[\\\x00-\x1f\x7f]/.test(entry.name)||entry.path!==resolve(search,entry.name)||!['file','directory','symlink','other'].includes(entry.type))return refused('unknown_shape');
   if(entry.type==='file'&&!entry.denied)add(entry.path);
  }
 }else{
  if(!Array.isArray(result?.content)||result.content.length!==1||result.content[0].type!=='text'||typeof result.content[0].text!=='string')return refused('unknown_shape');
  const details=result.details??{};
  const allowed=tool==='find'?['resultLimitReached','truncation']:tool==='ls'?['entryLimitReached','truncation']:['matchLimitReached','truncation','linesTruncated'];
  if(Object.keys(details).some(k=>!allowed.includes(k)))return refused('unknown_shape');
  const limitKey=allowed[0],limit=details[limitKey],truncated=details.truncation?.truncated===true;
  if(limit!==undefined&&(!Number.isSafeInteger(limit)||limit<=0)||details.truncation&&typeof details.truncation.truncated!=='boolean')return refused('unknown_shape');
  complete=!limit&&!truncated;
  let text:string=result.content[0].text;
  const notices:string[]=[];
  if(limit)notices.push(tool==='find'?`${limit} results limit reached. Use limit=${limit*2} for more, or refine pattern`:tool==='ls'?`${limit} entries limit reached. Use limit=${limit*2} for more`:`${limit} matches limit reached. Use limit=${limit*2} for more, or refine pattern`);
  if(truncated)notices.push('50.0KB limit reached');
  if(tool==='grep'&&details.linesTruncated)notices.push('Some lines truncated to 500 chars. Use read tool to see full lines');
  if(notices.length){const suffix=`\n\n[${notices.join('. ')}]`;if(!text.endsWith(suffix))return refused('unknown_shape');text=text.slice(0,-suffix.length);}
  const empty=tool==='find'?'No files found matching pattern':tool==='ls'?'(empty directory)':'No matches found';
  if(text===empty){
   if(tool!=='grep'){try{lstatSync(resolve(search,empty));return refused('ambiguous_filename');}catch{}}
   return {paths:[],discoveryComplete:complete,remaining:complete?0:'unknown'};
  }
  const lines=text.split('\n'); // Pinned Pi truncateHead retains only complete lines.
  for(const line of lines){
   if(!line||/[\x00-\x1f\x7f]/.test(line))return refused('ambiguous_filename');
   let name=line;
   if(tool==='grep'){
    const match=/^([^:]+):(\d+): /.exec(line),context=/^([^:]+?)-(\d+)- /.exec(line);
    if(match&&context)return refused('ambiguous_filename');
    if(!match&&!context)return refused('unknown_shape');
    name=(match??context)![1];
    if(!Number.isSafeInteger(Number((match??context)![2]))||Number((match??context)![2])<1)return refused('unknown_shape');
    if(name.includes(':'))return refused('ambiguous_filename');
   }
   if(isAbsolute(name)||name.includes('\\')||name.trim()!==name||name.replace(/\/$/,'').split('/').some(p=>p==='.'||p==='..'||!p))return refused('ambiguous_filename');
   if(name.endsWith('/')){if(tool==='grep')return refused('unknown_shape');continue;}
   let isFile=false;try{isFile=tool==='grep'&&lstatSync(search).isFile();}catch{return refused('invalid_search_root');}
   const full=isFile?search:resolve(search,name);
   if(isFile&&basename(search)!==name)return refused('unknown_shape');
   try{checkedSourcePath(root,full);if(!unambiguous(full,tool==='grep'))return refused('ambiguous_filename');}catch{complete=false;continue;}
   add(full);
  }
 }
 return {paths:[...new Set(candidates)].sort(),discoveryComplete:complete,remaining:complete?0:'unknown',excluded};
}
