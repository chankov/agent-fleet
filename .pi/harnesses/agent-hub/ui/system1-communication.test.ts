import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { createCommunicationStore } from "../system1-communication-store.ts";
const coding=import.meta.resolve("@earendil-works/pi-coding-agent"),tui=import.meta.resolve("@earendil-works/pi-tui");
registerHooks({resolve(s,c,next){if(s==="@mariozechner/pi-coding-agent")return{url:coding,shortCircuit:true};if(s==="@mariozechner/pi-tui")return{url:tui,shortCircuit:true};return next(s,c);}});
const {openSystem1Communication}=await import("./system1-communication.ts");
const { TASK_TRIAGE_QUESTIONS, TASK_TRIAGE_QUESTION_VERSION, TASK_TRIAGE_STATE_VERSION } = await import("../task-triage-contract.ts");
test("Fleet communication enable, rows, Enter pair, both copies, failure and Esc",async()=>{
 const store=createCommunicationStore();let panel:any;const notices:string[]=[];let finish!:()=>void;const copied:string[]=[];let fail=false;
 const ctx:any={ui:{notify:(text:string)=>notices.push(text),custom:(factory:any)=>new Promise<void>(resolve=>{finish=resolve;panel=factory({terminal:{rows:16},requestRender(){}},{},{},resolve);})}};
 const pending=openSystem1Communication(ctx,store,async text=>{if(fail)throw Error();copied.push(text);});
 assert.match(panel.render(120).join("\n"),/capture OFF/);await panel.handleInput("e");assert.equal(store.enabled,true);
 await store.wrap({async evaluate(){return {status:"skipped",reason:"disabled"};}},{provider:"other",model:"model"}).evaluate({state:{task:"password=SENTINEL"},questions:[{id:"x",type:"predicate",instructions:"x"}],questionSetVersion:"dispatch-triage/v1"});
 const list=panel.render(160).join("\n");assert.match(list,/request/);assert.match(list,/response/);
 await panel.handleInput("\r");assert.match(panel.render(160).join("\n"),/Request/);await panel.handleInput("\r");assert.equal(copied.length,1);assert.ok(!copied[0].includes("SENTINEL"));
 await panel.handleInput("\x1b[C");await panel.handleInput("\r");assert.equal(copied.length,2);assert.match(copied[1],/skipped/);
 fail=true;await panel.handleInput("\r");assert.ok(notices.includes("Clipboard unavailable"));
 await panel.handleInput("\x1b");await panel.handleInput("d");assert.equal(store.snapshot().length,0);await panel.handleInput("\x1b");await pending;panel.dispose();finish();
});

test("task-triage viewer separates provider result from task acceptance and preserves copy/clear", async () => {
 const store = createCommunicationStore(); let panel: any; const copied: string[] = [], notices: string[] = [];
 const terminal = { rows: 18 };
 const ctx: any = { ui: { notify: (text: string) => notices.push(text), custom: (factory: any) =>
  new Promise<void>(resolve => { panel = factory({ terminal, requestRender() {} }, {}, {}, resolve); }) } };
 const pending = openSystem1Communication(ctx, store, async text => { copied.push(text); });
 await panel.handleInput("e");
 await store.wrap({ async evaluate() { return { status: "ok", evaluation: {
  answers: TASK_TRIAGE_QUESTIONS.map(q => ({ questionId: q.id, type: "predicate", probabilityTrue: 0.9,
   uncertainty: { provenance: "provider" } })), metadata: { provider: "typesafe", requestedModel: "jev-1.13.0",
   returnedModel: "jev-1.13.0", questionSetVersion: TASK_TRIAGE_QUESTION_VERSION, latencyMs: 12, attempts: 1 } } }; } },
  { provider: "typesafe", model: "jev-1.13.0" }).evaluate({ state: { schema: TASK_TRIAGE_STATE_VERSION,
   task: "Inspect trust boundary", clarifications: [], paths: [], constraints: [], gaps: [], body: "PRIVATE_BODY" },
   questions: TASK_TRIAGE_QUESTIONS, questionSetVersion: TASK_TRIAGE_QUESTION_VERSION });
 assert.match(panel.render(160).join("\n"), /task-triage hub/);
 await panel.handleInput("\r");
 assert.match(panel.render(160).join("\n"), /Provider result only; task acceptance and obligations are separate/);
 await panel.handleInput("\r");
 assert.equal(copied.length, 1);
 assert.equal(JSON.parse(copied[0]).state.schema, TASK_TRIAGE_STATE_VERSION);
 assert.ok(!copied[0].includes("PRIVATE_BODY"));
 await panel.handleInput("\x1b[C"); await panel.handleInput("\r");
 assert.equal(JSON.parse(copied[1]).evaluation.answers[0].probabilityTrue, 0.9);
 terminal.rows = 8;
 for (const line of panel.render(40)) assert.equal((await import("@earendil-works/pi-tui")).visibleWidth(line), 40);
 store.setEnabled(false);
 assert.match(panel.render(100).join("\n"), /capture cleared/);
 await panel.handleInput("\r");
 assert.equal(copied.length, 2, "a cleared pair cannot be copied again");
 assert.ok(notices.includes("Payload unavailable; nothing copied"));
 await panel.handleInput("\x1b"); await panel.handleInput("\x1b"); await pending; panel.dispose();
});

test("task-triage withheld request cannot be copied but timeout stays visible", async () => {
 const store = createCommunicationStore(); let panel: any; const notices: string[] = [], copied: string[] = [];
 const ctx: any = { ui: { notify: (text: string) => notices.push(text), custom: (factory: any) =>
  new Promise<void>(resolve => { panel = factory({ terminal: { rows: 18 }, requestRender() {} }, {}, {}, resolve); }) } };
 const pending = openSystem1Communication(ctx, store, async text => { copied.push(text); });
 await panel.handleInput("e");
 await store.wrap({ async evaluate() { return { status: "unavailable", reason: "timeout" }; } },
  { provider: "typesafe", model: "jev-1.13.0" }).evaluate({ state: { schema: TASK_TRIAGE_STATE_VERSION,
   task: "x".repeat(33 * 1024), clarifications: [], paths: [], constraints: [], gaps: [] },
   questions: TASK_TRIAGE_QUESTIONS, questionSetVersion: TASK_TRIAGE_QUESTION_VERSION });
 assert.match(panel.render(160).join("\n"), /task-triage/);
 await panel.handleInput("\r");
 assert.match(panel.render(160).join("\n"), /payload withheld or too large/);
 assert.match(panel.render(160).join("\n"), /timeout/);
 await panel.handleInput("\r"); assert.deepEqual(copied, []);
 assert.ok(notices.includes("Payload unavailable; nothing copied"));
 await panel.handleInput("\x1b[C"); await panel.handleInput("\r");
 assert.deepEqual(JSON.parse(copied[0]), { status: "unavailable", reason: "timeout" });
 await panel.handleInput("\x1b"); await panel.handleInput("d"); await panel.handleInput("\x1b"); await pending; panel.dispose();
});

test("communication overlay paints an opaque full viewport for empty, populated, detail and resized views",async()=>{
 const {visibleWidth}=await import("@earendil-works/pi-tui");
 const store=createCommunicationStore();let panel:any;
 const terminal={rows:24};
 const ctx:any={ui:{notify(){},custom:(factory:any)=>new Promise<void>(resolve=>{panel=factory({terminal,requestRender(){}},{},{},resolve);})}};
 const pending=openSystem1Communication(ctx,store,async()=>{});
 const assertOpaque=(width:number)=>{
  const lines=panel.render(width);
  assert.equal(lines.length,terminal.rows,"must occupy full terminal height, not a centered short overlay");
  for(const line of lines)assert.equal(visibleWidth(line),width,"blank and short rows must overwrite Fleet background across full width");
  if(terminal.rows>=3 && width>=120)assert.match(lines.at(-1),/Esc/);
 };
 assertOpaque(100);
 await panel.handleInput("e");assertOpaque(100);
 await store.wrap({async evaluate(){return {status:"skipped",reason:"disabled"};}},{provider:"fake",model:"fake"}).evaluate({state:{task:"Inspect code"},questions:[{id:"x",type:"predicate",instructions:"Inspect"}],questionSetVersion:"dispatch-triage/v1"});
 assertOpaque(100);await panel.handleInput("\r");assertOpaque(100);
 terminal.rows=8;assertOpaque(40);terminal.rows=40;assertOpaque(120);
 terminal.rows=2;assertOpaque(12);
 await panel.handleInput("\x1b");await panel.handleInput("\x1b");await pending;panel.dispose();
});

test('agentic viewer copies only metadata, with an explicit advisory/no-gate label',async()=>{
 const {createAgenticRuntime}=await import('../agentic-runtime.ts');
 const {parseAgenticConfig}=await import('../../lib/system1/config-agentic.js');
 const store=createCommunicationStore();let panel:any;const copied:string[]=[];
 const ctx:any={ui:{notify(){},custom:(factory:any)=>new Promise<void>(resolve=>{panel=factory({terminal:{rows:30},requestRender(){}},{},{},resolve);})}};
 const pending=openSystem1Communication(ctx,store,async text=>{copied.push(text);});await panel.handleInput('e');
 const runtime=createAgenticRuntime({config:parseAgenticConfig({mode:'advisory',remoteContextApproved:true}),sessionId:'s',context:()=> 't',persist(){},observe:(id,status)=>store.finishAgentic(id,status),service:store.wrap({evaluate:async()=>({status:'unavailable',reason:'timeout'})},{provider:'fake',model:'fake'})});
 await runtime.evaluate({state:'PRIVATE_STATE',questions:[{id:'PRIVATE_ID',type:'predicate',instructions:'PRIVATE_QUESTION'}]});assert.match(panel.render(160).join('\n'),/agenticAsk hub.*unavailable/);
 await panel.handleInput('\r');assert.match(panel.render(160).join('\n'),/Advisory metadata only/);await panel.handleInput('\r');await panel.handleInput('\x1b[C');await panel.handleInput('\r');
 assert.equal(JSON.parse(copied[0]).state.questionCount,1);assert.equal(JSON.parse(copied[1]).status,'unavailable');assert.equal(JSON.parse(copied[1]).usage,null);assert.ok(!copied.join('').includes('PRIVATE_'));
 await panel.handleInput('\x1b');await panel.handleInput('\x1b');await pending;panel.dispose();
});
