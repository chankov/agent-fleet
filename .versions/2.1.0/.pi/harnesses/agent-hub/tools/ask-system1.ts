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
 description:'Advisory semantic batches: classification, relevance, risk, assumptions, clarity, failures. Recommended mode: call first, even for small tasks, before extended reasoning/research. Minimal non-secret state, selected repo paths/ranges within approved include (git:tracked uses the Git index), opted-in bash refs. source_denied is a local guard refusal, not a model answer; never bypass it via state/questions. No execution, rights, test/review proof, gate changes or replacement of pre-edit reading. Hash/readback summaries only, no bodies. Parent Hub opt-in required; unavailable/partial evidence refuses, never truncates. Choices require other/unknown.',
 async execute(_id,params,signal) {
  const result=await deps.runtime()?.evaluate(params,signal)??{status:'skipped',reason:'consumer_off',advisory:true,sourceSummary:[]};
  return {content:[{type:'text',text:JSON.stringify(result)}],details:result};
 }});
}
