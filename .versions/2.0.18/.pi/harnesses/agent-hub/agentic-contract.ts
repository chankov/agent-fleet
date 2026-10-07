import type { JsonText, System1Question, System1Result } from '../lib/system1/contracts.ts';
import { AGENTIC_LIMITS } from '../lib/system1/config-agentic.js';
import { containsCommunicationSecret } from './system1-communication-store.ts';
export const AGENTIC_VERSION = 'agentic-ask/v1';
export interface AgenticConfig { mode: 'off' | 'advisory' | 'recommended'; remoteContextApproved: boolean; include: string[]; allowToolOutputs: boolean; limits: Record<keyof typeof AGENTIC_LIMITS, number>; }
export interface AgenticInput { state?: JsonText; paths?: { path: string; startLine?: number; endLine?: number }[]; evidenceRefs?: string[]; questions: System1Question[]; }
export interface SourceSummary { kind: 'file' | 'output'; ref: string; hash: string; bytes: number; path?: string; startLine?: number; endLine?: number; totalLines?: number; complete: boolean; toolCallId?: string; exitCode?: number; isError?: boolean; truncation?: 'complete' | 'partial' | 'unknown'; readbackHandle?: string; sourcePathsKnown?: boolean; }
export type AgenticReason = 'consumer_off' | 'not_approved' | 'budget_exhausted' | 'invalid_input' | 'source_denied' | 'source_changed' | 'evidence_incomplete' | 'evidence_unavailable' | 'state_too_large' | 'counter_restore_ambiguous' | 'persistence_failed' | 'collection_timeout';
export type AgenticResult = (System1Result | { status: 'skipped' | 'unavailable'; reason: AgenticReason } | { status: 'stale'; reason: 'source_changed' }) & { evaluationId: string; advisory: true; sourceSummary: SourceSummary[]; breakdown?: Record<string, number> };
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const keys = (v: Record<string, any>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
function json(v: unknown, seen = new Set<object>(), depth = 0): boolean {
 if (depth > 30) return false;
 if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
 if (typeof v === 'number') return Number.isFinite(v);
 if ((!record(v) && !Array.isArray(v)) || seen.has(v as object)) return false;
 seen.add(v as object); const ok = Object.values(v as object).every(x => json(x,seen,depth+1)); seen.delete(v as object); return ok;
}
const text = (v: unknown) => (typeof v === 'string' ? !!v.trim() : record(v) || Array.isArray(v)) && json(v);
export function validateAgenticInput(value: unknown, limits: AgenticConfig['limits'] = AGENTIC_LIMITS): { ok: true; input: AgenticInput } | { ok: false; reason: 'invalid_input' | 'state_too_large' | 'source_denied'; breakdown?: Record<string,number> } {
 if (!record(value) || !keys(value,['state','paths','evidenceRefs','questions']) || !json(value)) return { ok:false, reason:'invalid_input' };
 const q = value.questions;
 if (!Array.isArray(q) || !q.length || q.length > limits.maxQuestions || new Set(q.map(x=>x?.id)).size !== q.length) return {ok:false,reason:'invalid_input'};
 for (const x of q) {
  if (!record(x) || !id(x.id) || !text(x.instructions)) return {ok:false,reason:'invalid_input'};
  if (x.type === 'choice') {
   if (!keys(x,['id','type','instructions','options']) || !record(x.options) || Object.keys(x.options).length < 2 || Object.keys(x.options).length > 255 || !Object.keys(x.options).some(k=>k==='other'||k==='unknown') || Object.entries(x.options).some(([k,v])=>!id(k)||(v!==null&&!text(v)))) return {ok:false,reason:'invalid_input'};
  } else if (x.type === 'ordinal') {
   if (!keys(x,['id','type','instructions','levels']) || !Array.isArray(x.levels) || x.levels.length < 2 || x.levels.length > 10 || new Set(x.levels).size !== x.levels.length || x.levels.some(l=>typeof l!=='string'||!l.trim()||Buffer.byteLength(l)>256)) return {ok:false,reason:'invalid_input'};
  } else if (x.type === 'predicate') {
   if (!keys(x,['id','type','instructions','criteria']) || (x.criteria!==undefined && (!record(x.criteria)||!keys(x.criteria,['true','false'])||Object.values(x.criteria).some(v=>!text(v))))) return {ok:false,reason:'invalid_input'};
  } else return {ok:false,reason:'invalid_input'};
 }
 if (value.state !== undefined && !text(value.state)) return {ok:false,reason:'invalid_input'};
 if (value.paths !== undefined && (!Array.isArray(value.paths)||value.paths.length>limits.maxFiles||value.paths.some(p=>!record(p)||!keys(p,['path','startLine','endLine'])||typeof p.path!=='string'||!p.path||p.path.length>1024||[p.startLine,p.endLine].some(n=>n!==undefined&&(!Number.isSafeInteger(n)||n<1))||(p.endLine!==undefined&&p.endLine<(p.startLine??1))))) return {ok:false,reason:'invalid_input'};
 if (value.evidenceRefs !== undefined && (!Array.isArray(value.evidenceRefs)||value.evidenceRefs.length>limits.maxHandles||value.evidenceRefs.some(r=>typeof r!=='string'||r.length>256)||new Set(value.evidenceRefs).size!==value.evidenceRefs.length)) return {ok:false,reason:'invalid_input'};
 if (value.state===undefined&&!value.paths?.length&&!value.evidenceRefs?.length) return {ok:false,reason:'invalid_input'};
 const breakdown = { state: value.state===undefined?0:Buffer.byteLength(JSON.stringify(value.state)), questions:Buffer.byteLength(JSON.stringify(q)), input:Buffer.byteLength(JSON.stringify(value)) };
 if (breakdown.state>limits.maxStateBytes||breakdown.questions>limits.maxQuestionsBytes||breakdown.input>limits.maxRequestBytes) return {ok:false,reason:'state_too_large',breakdown};
 if (containsCommunicationSecret(JSON.stringify(value))) return {ok:false,reason:'source_denied'};
 return {ok:true,input:structuredClone(value) as AgenticInput};
}
