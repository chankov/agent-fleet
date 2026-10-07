import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { CONTENT_REPLY_BYTES } from "./deterministic-fs.ts";
import { registerFilesystemTool, filesystemPolicyRootsFromEnv, FILESYSTEM_POLICY_ROOTS_ENV } from "./filesystem-tool.ts";
import { resolvePolicyRoots } from "../lib/policy-roots.ts";
import { decodeDeterministicHandle } from "../lib/deterministic-handle-path.ts";

registerHooks({resolve(specifier,context,nextResolve){if(specifier==="@mariozechner/pi-coding-agent")return{url:"data:text/javascript,export const isToolCallEventType=(name,event)=>event.toolName===name;",shortCircuit:true};return nextResolve(specifier,context);}});
const damageControl = (await import("../damage-control-continue/index.ts")).default;
import { resolveWorkModeTools } from "./work-mode.ts";
import { resolveDelegateTools } from "./helpers.ts";

const temp = () => mkdtempSync(join(tmpdir(), "fleet-filesystem-tool-"));
const invoke = async (tool: any, params: any, cwd: string) => tool.execute("call", params, new AbortController().signal, () => {}, { cwd });

test("external grants support bounded reads with root-bound handles and confined snapshots", async t => {
 const base=temp(), tools:any[]=[];
 t.after(()=>rmSync(base,{recursive:true,force:true}));
 const root=join(base,"code"), docs=join(base,"docs"), session=join(root,".pi/session");
 mkdirSync(session,{recursive:true}); mkdirSync(docs);
 const file=join(docs,"README.md"); writeFileSync(file,"external content");
 writeFileSync(join(docs,".env"),"private"); mkdirSync(join(docs,"dist"));
 symlinkSync(root,join(docs,"escape"));
 let table=resolvePolicyRoots(root,{docsPaths:["../docs"]});
 registerFilesystemTool({registerTool:(tool:any)=>tools.push(tool)} as any,{enabled:()=>true,sessionDir:()=>session,policyRoots:()=>table});
 const tool=tools[0];
 assert.equal((await invoke(tool,{operation:"stat",path:"../docs/README.md"},root)).details.result.bytes,16);
 const listed=(await invoke(tool,{operation:"inventory",path:"../docs"},root)).details.result;
 assert.deepEqual(listed.entries.map((e:any)=>e.name),["README.md"]);
 writeFileSync(join(docs,"second.md"),"second");
 const page=(await invoke(tool,{operation:"inventory",path:"../docs",page_size:1},root)).details.result;
 assert.equal(decodeDeterministicHandle(page.nextHandle).rootId,table.roots[1]!.id);
 const next=(await invoke(tool,{operation:"inventory",path:"../docs",handle:page.nextHandle,page_size:1},root)).details.result;
 assert.equal(next.entries[0].name,"second.md");
 writeFileSync(join(docs,"third.md"),"third");
 await assert.rejects(()=>invoke(tool,{operation:"inventory",path:"../docs",handle:page.nextHandle},root),/Stale inventory/);
 const first=(await invoke(tool,{operation:"excerpt",path:"../docs/README.md",max_bytes:4},root)).details.result;
 assert.equal(first.content,"exte");
 assert.equal((decodeDeterministicHandle(first.nextHandle) as any).rootId,table.roots[1]!.id);
 assert.equal((await invoke(tool,{operation:"readback",handle:first.nextHandle,max_bytes:4},root)).details.result.content,"rnal");
 await assert.rejects(()=>invoke(tool,{operation:"stat",path:".."},root),/ungranted/);
 await assert.rejects(()=>invoke(tool,{operation:"excerpt",path:"../other/file"},root),/ungranted/);
 await assert.rejects(()=>invoke(tool,{operation:"excerpt",path:"../docs/.env"},root),/denied/);
 await assert.rejects(()=>invoke(tool,{operation:"inventory",path:"../docs/escape"},root),/escape/);
 await assert.rejects(()=>invoke(tool,{operation:"snapshot",path:"../docs/README.md",origin:"file"},root),/workspace/);
 assert.equal(existsSync(join(session,"artifacts")),false);
 table=resolvePolicyRoots(root,{docsPaths:["../docs/README.md"]});
 await assert.rejects(()=>invoke(tool,{operation:"readback",handle:first.nextHandle},root),/root|grant/);
 await assert.rejects(()=>invoke(tool,{operation:"inventory",path:"../docs"},root),/ungranted/);
 await assert.rejects(()=>invoke(tool,{operation:"excerpt",path:"../docs/second.md"},root),/ungranted/);
 await assert.rejects(()=>invoke(tool,{operation:"inventory",path:file},root),/directory/);
 writeFileSync(file,"changed");
 const current=(await invoke(tool,{operation:"excerpt",path:"../docs/README.md"},root)).details.result;
 writeFileSync(file,"changed again");
 await assert.rejects(()=>invoke(tool,{operation:"readback",handle:current.onDiskHandle},root),/Stale/);
});

test("external handles reauthorize symlink roots, reject forgery and retain session boundaries", async t => {
 const base=temp(), tools:any[]=[];
 t.after(()=>rmSync(base,{recursive:true,force:true}));
 const root=join(base,"code"), docs=join(base,"docs"), session=join(root,".pi/session"), otherSession=join(base,"other-session");
 mkdirSync(session,{recursive:true}); mkdirSync(join(root,"nested")); mkdirSync(otherSession); mkdirSync(docs);
 writeFileSync(join(docs,"README.md"),"external");
 symlinkSync(docs,join(base,"alias"));
 const table=resolvePolicyRoots(root,{docsPaths:["../alias"]});
 registerFilesystemTool({registerTool:(tool:any)=>tools.push(tool)} as any,{enabled:()=>true,sessionDir:()=>session,policyRoots:()=>table});
 const tool=tools[0], nested=join(root,"nested");
 const first=(await invoke(tool,{operation:"excerpt",path:"../alias/README.md"},nested)).details.result;
 assert.equal(first.path,join(docs,"README.md"));
 const stripped=decodeDeterministicHandle(first.onDiskHandle); delete stripped.rootId;
 await assert.rejects(()=>invoke(tool,{operation:"readback",handle:`t5:${Buffer.from(JSON.stringify(stripped)).toString("base64url")}`},root),/root grant/);
 writeFileSync(join(otherSession,"note.md"),"other session");
 const foreign=`t5:${Buffer.from(JSON.stringify({v:1,kind:"file",path:join(otherSession,"note.md"),hash:createHash("sha256").update("other session").digest("hex"),offset:0})).toString("base64url")}`;
 await assert.rejects(()=>invoke(tool,{operation:"readback",handle:foreign},root),/ungranted/);
 unlinkSync(join(base,"alias")); symlinkSync(root,join(base,"alias"));
 await assert.rejects(()=>invoke(tool,{operation:"readback",handle:first.onDiskHandle},root),/root_changed/);
});

test("external readback retains orchestrator byte ceilings and managed-readback veto", async t => {
 const base=temp(), tools:any[]=[];
 t.after(()=>rmSync(base,{recursive:true,force:true}));
 const root=join(base,"code"), docs=join(base,"docs"), session=join(root,"session");
 mkdirSync(session,{recursive:true}); mkdirSync(docs);
 const file=join(docs,"large.md"); writeFileSync(file,Buffer.alloc(CONTENT_REPLY_BYTES+1,97));
 let readOnly=false, allowed=true, remaining=1000;
 registerFilesystemTool({registerTool:(tool:any)=>tools.push(tool)} as any,{enabled:()=>!readOnly,readOnly:()=>readOnly,sessionDir:()=>session,policyRoots:()=>resolvePolicyRoots(root,{docsPaths:["../docs"]}),managedReadbackAllowed:()=>allowed,remainingSelfReadBytes:()=>remaining,noteSelfReadBytes:bytes=>{remaining-=bytes;}});
 const first=(await invoke(tools[0],{operation:"excerpt",path:file,max_bytes:10},root)).details.result;
 readOnly=true;
 assert.equal((await invoke(tools[0],{operation:"readback",handle:first.nextHandle},root)).details.result.reason,"too_large");
 assert.equal((await invoke(tools[0],{operation:"excerpt",path:file},root)).details.result.content,null);
 allowed=false;
 await assert.rejects(()=>invoke(tools[0],{operation:"readback",handle:first.nextHandle},root),/stale or denied/);
 allowed=true; writeFileSync(file,"small"); remaining=0;
 assert.equal((await invoke(tools[0],{operation:"excerpt",path:file},root)).details.result.reason,"too_large");
});

test("standalone child filesystem receives root table without widening malformed grants", t => {
 const base=temp();t.after(()=>rmSync(base,{recursive:true,force:true}));
 const root=join(base,"code"),docs=join(base,"docs");mkdirSync(root);mkdirSync(docs);
 const table=resolvePolicyRoots(root,{docsPaths:["../docs"]});
 const loaded=filesystemPolicyRootsFromEnv({[FILESYSTEM_POLICY_ROOTS_ENV]:JSON.stringify(table)});
 assert.equal(loaded?.workspace,root);assert.equal(loaded?.roots[1]?.canonicalPath,docs);
 assert.throws(()=>filesystemPolicyRootsFromEnv({[FILESYSTEM_POLICY_ROOTS_ENV]:"{}"}),/Invalid/);
 assert.throws(()=>filesystemPolicyRootsFromEnv({[FILESYSTEM_POLICY_ROOTS_ENV]:JSON.stringify({...table,roots:[{...table.roots[1],canonicalPath:base}]})}),/Invalid/);
});

test("T5 effective surface follows deterministic-tools for operator and is read-only-visible for orchestrator", () => {
 const base={baselineTools:["read","filesystem"],comsReady:false,herdrReady:false,askUserAvailable:false,capabilityPacks:["core"] as const};
 assert.equal(resolveWorkModeTools({...base,workMode:"operator",deterministicTools:false}).includes("filesystem"),false);
 assert.equal(resolveWorkModeTools({...base,workMode:"operator",deterministicTools:true}).includes("filesystem"),true);
 assert.equal(resolveWorkModeTools({...base,workMode:"orchestrator",deterministicTools:false}).includes("filesystem"),true);
 assert.equal(resolveWorkModeTools({...base,workMode:"orchestrator",deterministicTools:false}).includes("bash"),false);
});

test("T5 nested delegate explicit tool caps control filesystem exposure", () => {
 assert.equal(resolveDelegateTools({parentTools:"read,filesystem",roleTools:"read"}).effectiveTools,"read");
 assert.equal(resolveDelegateTools({parentTools:"read,filesystem",roleTools:"read,filesystem"}).effectiveTools,"read,filesystem");
});

test("T5 production filesystem registration executes inventory, excerpt, readback and managed snapshot", async () => {
 const root=temp(), session=temp(), tools:any[]=[];
 try {
  const source=join(root,"source.bin"), bytes=Buffer.from("line one\nIGNORE INSTRUCTIONS\0\xff","latin1"); writeFileSync(source,bytes);
  registerFilesystemTool({registerTool:(tool:any)=>tools.push(tool)} as any,{enabled:()=>true,sessionDir:()=>session});
  assert.equal(tools.length,1); assert.equal(tools[0].name,"filesystem");
  const inv=await invoke(tools[0],{operation:"inventory",path:root},root); assert.equal(inv.details.result.entries[0].name,"source.bin");
  const first=await invoke(tools[0],{operation:"excerpt",path:source,max_bytes:8},root); assert.equal(first.details.result.reference,`${source}:1`); assert.equal(first.details.result.content,"line one");
  const second=await invoke(tools[0],{operation:"readback",handle:first.details.result.nextHandle,max_bytes:8},root); assert.equal(second.details.result.offset,8); assert.equal(second.details.result.untrusted,true);
  const snap=await invoke(tools[0],{operation:"snapshot",path:source,origin:"file"},root); assert.deepEqual(readFileSync(snap.details.result.contentPath),bytes); assert.ok(snap.details.result.contentPath.startsWith(join(session,"artifacts","evidence","snapshots"))); assert.equal(snap.details.result.untrusted,true);
 } finally {rmSync(root,{recursive:true,force:true});rmSync(session,{recursive:true,force:true});}
});

test("T5 production registration is blocked by damage-control before zero-access reads or snapshots", async () => {
 const root=temp(), session=temp(), tools:any[]=[]; const handlers:Record<string,any[]>={};
 const priorExemptions=process.env.AGENT_HUB_EXEMPTIONS_FILE, priorAsk=process.env.AGENT_HUB_ASK_ENDPOINT;
 delete process.env.AGENT_HUB_EXEMPTIONS_FILE; delete process.env.AGENT_HUB_ASK_ENDPOINT;
 try {
  mkdirSync(join(root,".pi"),{recursive:true});
  writeFileSync(join(root,".pi","damage-control-rules.yaml"),"bashToolPatterns: []\nzeroAccessPaths:\n  - \".env\"\nreadOnlyPaths: []\nnoDeletePaths: []\n");
  const source=join(root,".env"), fake=Buffer.from("FAKE_TEST_TOKEN=not-a-secret\n"); writeFileSync(source,fake);
  const pi:any={registerTool:(tool:any)=>tools.push(tool),registerCommand:()=>{},on:(name:string,fn:any)=>{(handlers[name]??=[]).push(fn);},appendEntry:()=>{}};
  damageControl(pi); registerFilesystemTool(pi,{enabled:()=>true,sessionDir:()=>session});
  const notices:string[]=[]; const ctx:any={cwd:root,hasUI:false,ui:{notify:(message:string)=>notices.push(message),setStatus:()=>{}}};
  for(const fn of handlers.session_start??[]) await fn({},ctx);
  const tool=tools.find(tool=>tool.name==="filesystem");
  assert.equal((await handlers.tool_call[0]({type:"tool_call",toolName:"read",input:{path:".env"}},ctx)).block,true,`fixture must activate zero-access policy: ${notices.join(" | ")}`);
  const guarded=async(params:any)=>{const event={type:"tool_call",toolName:"filesystem",input:params};const decision=await handlers.tool_call[0](event,ctx);if(decision.block)return decision;return invoke(tool,params,root);};
  const hash=createHash("sha256").update(fake).digest("hex");
  const handle=`t5:${Buffer.from(JSON.stringify({v:1,kind:"file",path:source,hash,offset:0})).toString("base64url")}`;
  for(const params of [{operation:"inventory",path:".env"},{operation:"excerpt",path:".env"},{operation:"readback",handle},{operation:"snapshot",origin:"file",path:".env"}]) {
   const denied=await guarded(params); assert.equal(denied.block,true); assert.match(denied.reason,/zero-access/i);
  }
  assert.equal(existsSync(join(session,"artifacts")),false,"blocked snapshot must create no artifact tree");
 } finally {if(priorExemptions===undefined)delete process.env.AGENT_HUB_EXEMPTIONS_FILE;else process.env.AGENT_HUB_EXEMPTIONS_FILE=priorExemptions;if(priorAsk===undefined)delete process.env.AGENT_HUB_ASK_ENDPOINT;else process.env.AGENT_HUB_ASK_ENDPOINT=priorAsk;rmSync(root,{recursive:true,force:true});rmSync(session,{recursive:true,force:true});}
});

test("T5 filesystem refuses disabled, forged, remote, destination and symlink escape invocations", async () => {
 const root=temp(), outside=temp(), session=temp(), enabled={value:false}, tools:any[]=[];
 try {
  const secret=join(outside,"secret");writeFileSync(secret,"secret");symlinkSync(outside,join(root,"escape"));
  registerFilesystemTool({registerTool:(tool:any)=>tools.push(tool)} as any,{enabled:()=>enabled.value,sessionDir:()=>session});
  await assert.rejects(()=>invoke(tools[0],{operation:"inventory",path:root},root),/disabled|stale/i);
  enabled.value=true;
  await assert.rejects(()=>invoke(tools[0],{operation:"readback",handle:"t5:forged"},root),/invalid/i);
  await assert.rejects(()=>invoke(tools[0],{operation:"snapshot",origin:"https",path:"https://example.invalid/x"},root),/local|origin|unsupported/i);
  await assert.rejects(()=>invoke(tools[0],{operation:"snapshot",origin:"file",path:secret,destination:join(root,"x")},root),/destination|parameter/i);
  await assert.rejects(()=>invoke(tools[0],{operation:"inventory",path:join(root,"escape")},root),/symlink/i);
  await assert.rejects(()=>invoke(tools[0],{operation:"snapshot",origin:"file",path:join(root,"escape","secret")},root),/symlink/i);
 } finally {rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});rmSync(session,{recursive:true,force:true});}
});

test("orchestrator read-only filesystem inspects and refuses snapshot", async () => {
 const root=temp(), session=temp(), tools:any[]=[];
 try {
  writeFileSync(join(root,"note.txt"),"visible");
  registerFilesystemTool({registerTool:(tool:any)=>tools.push(tool)} as any,{enabled:()=>false,readOnly:()=>true,sessionDir:()=>session});
  const listed=await invoke(tools[0],{operation:"inventory",path:root},root);
  assert.equal(listed.details.result.entries.some((entry:any)=>entry.name==="note.txt"),true);
  const excerpted=await invoke(tools[0],{operation:"excerpt",path:join(root,"note.txt")},root);
  assert.match(String(excerpted.details.result.content),/visible/);
  await assert.rejects(()=>invoke(tools[0],{operation:"snapshot",origin:"file",path:join(root,"note.txt")},root),/deterministic-tools|snapshot/i);
  assert.equal(existsSync(join(session,"artifacts")),false);
 } finally {rmSync(root,{recursive:true,force:true});rmSync(session,{recursive:true,force:true});}
});

test("orchestrator read-only filesystem stats size and refuses self-read above 64 KiB", async () => {
 const root=temp(), session=temp(), readOnlyTools:any[]=[], enabledTools:any[]=[];
 try {
  const big=join(root,"big.txt");
  writeFileSync(big, Buffer.alloc(CONTENT_REPLY_BYTES + 1, 0x61));
  registerFilesystemTool({registerTool:(tool:any)=>readOnlyTools.push(tool)} as any,{enabled:()=>false,readOnly:()=>true,sessionDir:()=>session});
  const sized=await invoke(readOnlyTools[0],{operation:"stat",path:big},root);
  assert.equal(sized.details.result.bytes, CONTENT_REPLY_BYTES + 1);
  assert.equal(sized.details.result.selfRead, false);
  const refused=await invoke(readOnlyTools[0],{operation:"excerpt",path:big},root);
  assert.equal(refused.details.result.refused, true);
  assert.equal(refused.details.result.reason, "too_large");
  assert.equal(refused.details.result.content, null);
  assert.match(refused.details.result.instruction, /spawn_research/);
  const handle=`t5:${Buffer.from(JSON.stringify({v:1,kind:"file",path:big,hash:"ab".repeat(32),offset:0})).toString("base64url")}`;
  const readRefused=await invoke(readOnlyTools[0],{operation:"readback",handle},root);
  assert.equal(readRefused.details.result.content, null);
  assert.equal(readRefused.details.result.reason, "too_large");
  registerFilesystemTool({registerTool:(tool:any)=>enabledTools.push(tool)} as any,{enabled:()=>true,sessionDir:()=>session});
  const paged=await invoke(enabledTools[0],{operation:"excerpt",path:big},root);
  assert.equal(paged.details.result.refused, undefined);
  assert.equal(paged.details.result.contentBytes, CONTENT_REPLY_BYTES);
 } finally {rmSync(root,{recursive:true,force:true});rmSync(session,{recursive:true,force:true});}
});

test("orchestrator self-read turn budget refuses the next file and an inventory once the ceiling is spent", async () => {
 const root=temp(), session=temp(), tools:any[]=[], used={bytes:0}, ceiling=10_000;
 try {
  writeFileSync(join(root,"a.txt"), "a".repeat(6_000));
  writeFileSync(join(root,"b.txt"), "b".repeat(6_000));
  registerFilesystemTool({registerTool:(tool:any)=>tools.push(tool)} as any,{
   enabled:()=>false, readOnly:()=>true, sessionDir:()=>session,
   remainingSelfReadBytes:()=>Math.max(0, ceiling-used.bytes), noteSelfReadBytes:bytes=>{used.bytes+=bytes;},
  });
  const first=await invoke(tools[0],{operation:"excerpt",path:join(root,"a.txt")},root);
  assert.match(String(first.details.result.content), /a{6000}/);
  const second=await invoke(tools[0],{operation:"excerpt",path:join(root,"b.txt")},root);
  assert.equal(second.details.result.reason, "too_large");
  assert.equal(second.details.result.content, null);
  used.bytes=ceiling;
  const listed=await invoke(tools[0],{operation:"inventory",path:root},root);
  assert.equal(listed.details.result.reason, "too_large");
  assert.equal(listed.details.result.entries, undefined);
 } finally {rmSync(root,{recursive:true,force:true});rmSync(session,{recursive:true,force:true});}
});
