import type {ExtensionAPI} from '@mariozechner/pi-coding-agent';
import {Type} from '@sinclair/typebox';
import {ASK_SYSTEM1_PARAMETERS} from './ask-system1.ts';
export const ASK_SYSTEM1_FILES_PARAMETERS=Type.Object({
 paths:Type.Optional(Type.Array(Type.String({maxLength:1024}),{maxItems:1024})),
 patterns:Type.Optional(Type.Array(Type.String({maxLength:4096}),{maxItems:20})),
 directories:Type.Optional(Type.Array(Type.String({maxLength:1024}),{maxItems:20})),
 recursive:Type.Optional(Type.Boolean()),
 questions:Type.Optional(Type.Array(ASK_SYSTEM1_PARAMETERS.properties.questions.items,{maxItems:14})),
},{additionalProperties:false});
export function registerAskSystem1Files(pi:ExtensionAPI,deps:{execute(params:unknown,signal:AbortSignal|undefined):Promise<unknown>}){
 pi.registerTool({name:'ask_system1_files',label:'Rank files with System 1',parameters:ASK_SYSTEM1_FILES_PARAMETERS,
 description:'Parent-only approved file judgments via paths/patterns/directories: relevance, role and up to 14 custom questions. All scored/unscored rows remain available via filesystem pages. Never grants rights, replaces reading or proves correctness. Discovery auto-ranking needs no call.',
 async execute(_id,params,signal){const result=await deps.execute(params,signal);return {content:[{type:'text',text:JSON.stringify(result)}],details:result};}});
}
