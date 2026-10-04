import type {ExtensionAPI} from '@mariozechner/pi-coding-agent';
import {Type} from '@sinclair/typebox';
import type {AgenticRuntime} from '../agentic-runtime.ts';
// Nested values are JSON-validated again by the bounded runtime contract.
const json=Type.Unknown();
const text=Type.Union([Type.String(),Type.Array(json),Type.Record(Type.String(),json)]);
const base={id:Type.String({pattern:'^[A-Za-z0-9_-]{1,64}$'}),instructions:text};
export const ASK_SYSTEM1_PARAMETERS=Type.Object({
 state:Type.Optional(text),
 paths:Type.Optional(Type.Array(Type.Object({path:Type.String({maxLength:1024}),startLine:Type.Optional(Type.Integer({minimum:1})),endLine:Type.Optional(Type.Integer({minimum:1}))},{additionalProperties:false}),{maxItems:20})),
 evidenceRefs:Type.Optional(Type.Array(Type.String({maxLength:256}),{maxItems:20})),
 questions:Type.Array(Type.Union([
  Type.Object({...base,type:Type.Literal('choice'),options:Type.Record(Type.String(),Type.Union([text,Type.Null()]))},{additionalProperties:false}),
  Type.Object({...base,type:Type.Literal('predicate'),criteria:Type.Optional(Type.Object({true:Type.Optional(text),false:Type.Optional(text)},{additionalProperties:false}))},{additionalProperties:false}),
  Type.Object({...base,type:Type.Literal('ordinal'),levels:Type.Array(Type.String(),{minItems:2,maxItems:10})},{additionalProperties:false}),
 ]),{minItems:1,maxItems:16}),
},{additionalProperties:false});
export function registerAskSystem1(pi:ExtensionAPI,deps:{runtime():AgenticRuntime|null}) {
 pi.registerTool({name:'ask_system1',label:'Ask System 1',parameters:ASK_SYSTEM1_PARAMETERS,
 description:'Advisory System 1 batch for bounded semantic judgments: classification, selected-file relevance, risk, assumptions, request clarity and failure interpretation. In recommended mode, call first for suitable judgments, including small tasks, before extended reasoning or research for the same question. Use minimal non-secret state, selected repo files/ranges and opted-in recorded bash evidence refs. Never executes commands, grants rights, proves test/review pass, changes gates or replaces required reading before editing. Bodies are not returned; summaries retain hashes and local readback references. Explicit parent Hub opt-in only; unavailable/partial evidence refuses rather than truncates. Choice questions require other or unknown.',
 async execute(_id,params,signal) {
  const result=await deps.runtime()?.evaluate(params,signal)??{status:'skipped',reason:'consumer_off',advisory:true,sourceSummary:[]};
  return {content:[{type:'text',text:JSON.stringify(result)}],details:result};
 }});
}
