// Source-only pilot tooling. Default CLI is preview-only; explicit API live mode requires verified records and an explicit key.
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, unlinkSync, writeSync, fsyncSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJevProvider, defaultJevTransport, JEV_ENDPOINT, JEV_MODEL, type JevTransport, type JevHttpResponse } from '../.pi/harnesses/lib/system1/jev.ts';
import { createSystem1Service } from '../.pi/harnesses/lib/system1/service.ts';
import { buildTaskTriageState } from '../.pi/harnesses/agent-hub/task-triage-state.ts';
import { TASK_TRIAGE_POLICY_VERSION, TASK_TRIAGE_QUESTIONS, TASK_TRIAGE_QUESTION_VERSION } from '../.pi/harnesses/agent-hub/task-triage-contract.ts';
import { assessTaskTriage } from '../.pi/harnesses/agent-hub/task-triage-policy.ts';
import { createPilotBudget, type PilotBudgetBinding, type PilotAttempt } from './lib/task-triage-pilot-budget.ts';

type Body = { state: ReturnType<typeof buildState>; model: string; questions: Record<string, unknown> };
interface Preview { id: string; body: Body; }
interface Options {
 directory: string; mode?: 'dry-run' | 'execute-injected' | 'execute-live'; ledgerPath?: string; initializeLedger?: boolean;
 /** Live callers explicitly supply the key; this module never discovers credentials. */
 apiKey?: string;
 exampleIds?: string[]; transport?: JevTransport; signal?: AbortSignal;
 /** Trusted injected TEST accounting only. This is not provider pricing/usage evidence. */
 attemptCostMicrousd?: (response: JevHttpResponse) => number | null;
}
interface Row { id: string; status: string; assessment: ReturnType<typeof assessTaskTriage>; }
interface Result {
 status: 'dry_run' | 'completed' | 'blocked' | 'cancelled'; reason?: string; requests?: Preview[];
 binding?: PilotBudgetBinding; rows: Row[]; physicalAttempts: number;
 budget?: ReturnType<ReturnType<typeof createPilotBudget>['snapshot']>;
 taskAcceptance: 'not_recorded'; canonicalSecurityAccuracyEligible: boolean;
 budgetBasis?: 'externally_verified' | 'human_approved_public_pricing_assumption';
}
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const dataFiles = ['examples.json', 'labels.json', 'outbound-preview.json'] as const;
const additionalFiles = ['authorization.json', 'pricing.json'] as const;
const predicateKeys = TASK_TRIAGE_QUESTIONS.map(q => q.id);
const obligationKeys = ['plan', 'review', 'confirmation'];
const validId = (s: unknown): s is string => typeof s === 'string' && /^P(?:0[1-9]|[1-3][0-9]|40)$/.test(s);
const keys = (value: object) => Object.keys(value).sort().join(',');
function safePath(path: string) {
 let cursor = parse(path).root;
 for (const name of path.slice(cursor.length).split('/')) {
  cursor = join(cursor, name);
  try { if (lstatSync(cursor).isSymbolicLink()) throw Error('unsafe_path'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
 }
}
function readLocal(path: string) {
 safePath(path);
 const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
 try {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) throw Error('invalid_local_file');
  return readFileSync(fd, 'utf8');
 } finally { closeSync(fd); }
}
function buildState(task: string, root: string) {
 if (typeof task !== 'string' || /[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(task)) throw Error('invalid_task');
 const value = buildTaskTriageState({ task }, root);
 if (!value.ok) throw Error('input_' + value.reason);
 return value.state;
}
function checkCorpus(corpus: any, labels: any, preview: any) {
 if (corpus?.schema !== 'task-triage-pilot-corpus/v1' || corpus.questionVersion !== TASK_TRIAGE_QUESTION_VERSION
  || corpus.policyVersion !== TASK_TRIAGE_POLICY_VERSION || corpus.sourceScope !== 'current_repository_only' || corpus.scope !== null
  || labels?.schema !== 'task-triage-pilot-labels/v1' || labels.pairBindingConfirmed !== true
  || preview?.schema !== 'task-triage-pilot-preview/v1' || !Array.isArray(corpus.examples) || corpus.examples.length !== 40
  || !Array.isArray(labels.examples) || labels.examples.length !== 40 || !Array.isArray(preview.requests) || preview.requests.length !== 40) throw Error('invalid_corpus');
 const seen = new Set<string>();
 for (let i = 0; i < 40; i++) {
  const example = corpus.examples[i], label = labels.examples[i], body = preview.requests[i];
  if (!validId(example.id) || example.id !== 'P' + String(i + 1).padStart(2, '0') || seen.has(example.id)
   || !['bg', 'en'].includes(example.language) || typeof example.family !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(example.family)
   || label?.id !== example.id || body?.id !== example.id || keys(label.predicates ?? {}) !== [...predicateKeys].sort().join(',')
   || keys(label.obligations ?? {}) !== [...obligationKeys].sort().join(',')
   || [...Object.values(label.predicates), ...Object.values(label.obligations)].some(v => v !== null && typeof v !== 'boolean')) throw Error('invalid_corpus_row');
  seen.add(example.id);
 }
 if (corpus.examples.filter((e: any) => e.language === 'bg').length !== 20 || corpus.examples.filter((e: any) => e.language === 'en').length !== 20) throw Error('invalid_languages');
}
/** Obtain exact adapter JSON without a second wire serializer or real HTTP. */
async function previewBodies(corpus: any, root: string): Promise<Preview[]> {
 const requests: Preview[] = [];
 const provider = createJevProvider({ apiKey: 'synthetic-preview-only', transport: async request => {
  requests.push({ id: corpus.examples[requests.length].id, body: JSON.parse(request.body.toString('utf8')) });
  throw Error('offline_preview_intercept');
 } });
 for (const e of corpus.examples) await provider.evaluate({ state: buildState(e.task, root), questions: TASK_TRIAGE_QUESTIONS, questionSetVersion: TASK_TRIAGE_QUESTION_VERSION, timeoutMs: 2000 });
 if (requests.length !== 40) throw Error('preview_invalid');
 return requests;
}
function checkAuthorization(approval: any, pricing: any, hashes: Record<string, string>, corpus: any, labels: any, live: boolean) {
 if (approval?.schema !== 'task-triage-pilot-authorization/v1' || approval.execution !== (live ? 'live' : 'injected-test')
  || approval.approvedByHuman !== true || approval.technicalAccepted !== true || keys(approval.hashes ?? {}) !== [...dataFiles].sort().join(',')
  || dataFiles.some(f => approval.hashes[f] !== hashes[f])) throw Error('approval_missing_or_changed');
 const assumed = pricing?.basis === 'human_approved_public_pricing_assumption';
 if (assumed && (!live || pricing.externallyVerified !== false || pricing.humanApproved !== true
  || approval.pricingAssumptionAccepted !== true || pricing.maxInputTokens !== 65536
  || pricing.inputMicrousdPerMillionTokens !== 42000 || pricing.outputMicrousdPerMillionTokens !== 0
  || pricing.maxAttemptMicrousd !== Math.ceil(65536 * 42000 / 1_000_000)
  || pricing.evidence !== 'https://docs.typesafe.ai/models.md')) throw Error('pricing_assumption_unapproved_or_changed');
 if (pricing?.schema !== 'task-triage-pilot-pricing/v1' || pricing.currency !== 'USD' || !assumed && pricing.externallyVerified !== true
  || typeof pricing.evidence !== 'string' || !pricing.evidence.trim() || !Number.isSafeInteger(pricing.maxAttemptMicrousd)
  || pricing.maxAttemptMicrousd <= 0 || pricing.maxAttemptMicrousd > 5_000_000) throw Error('pricing_unverified');
 if (live && (approval.endpoint !== JEV_ENDPOINT || approval.model !== JEV_MODEL)) throw Error('live_destination_unapproved');
 // A dashboard showing past spend is not evidence of an all-attempt ceiling.
 // These fields record externally checked terms, not conclusions inferred by tests.
 if (live && !assumed && (pricing.billingBound !== 'all_physical_attempts_including_errors'
  || pricing.verificationSource !== 'provider_terms' || pricing.accountTermsConfirmed !== true)) throw Error('live_billing_bound_unverified');
 if (!Array.isArray(approval.groups) || approval.groups.length < 2 || approval.groups.length > 40) throw Error('split_missing');
 const assigned = new Map<string, string>(), groups = new Set<string>(), familySplits = new Map<string, string>();
 for (const group of approval.groups) {
  if (typeof group.id !== 'string' || groups.has(group.id) || !['development', 'held-out'].includes(group.split) || !Array.isArray(group.ids) || !group.ids.length) throw Error('invalid_split');
  groups.add(group.id);
  for (const id of group.ids) {
   if (!validId(id) || assigned.has(id)) throw Error('invalid_split');
   const i = corpus.examples.findIndex((e: any) => e.id === id);
   if (i < 0 || labels.examples[i].split !== group.split) throw Error('split_leakage');
   const family = corpus.examples[i].family;
   if (familySplits.has(family) && familySplits.get(family) !== group.split) throw Error('split_leakage');
   familySplits.set(family, group.split); assigned.set(id, group.split);
  }
 }
 if (assigned.size !== 40 || new Set(assigned.values()).size !== 2) throw Error('split_missing');
 for (let i = 0; i < 40; i += 2) if (corpus.examples[i].family !== corpus.examples[i + 1].family || assigned.get(corpus.examples[i].id) !== assigned.get(corpus.examples[i + 1].id)) throw Error('split_leakage');
}
function acquireRunLock(ledgerPath: string) {
 if (!isAbsolute(ledgerPath)) throw Error('unsafe_ledger_path');
 const path = ledgerPath + '.run-lock'; safePath(path);
 const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
 const stat = fstatSync(fd);
 try {
  writeSync(fd, 'pilot-injected-run\n'); fsyncSync(fd);
  const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(parent); } finally { closeSync(parent); }
 }
 catch (error) { closeSync(fd); throw error; } // Retain fence on failed lock persistence.
 return () => {
  closeSync(fd);
  const current = lstatSync(path);
  if (current.isSymbolicLink() || stat.ino !== current.ino || stat.dev !== current.dev) throw Error('run_lock_changed');
  unlinkSync(path);
  const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(parent); } finally { closeSync(parent); }
 };
}
function aborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
 if (signal.aborted) { void promise.catch(() => {}); return Promise.reject(Error('cancelled')); }
 return new Promise((resolveValue, reject) => {
  const abort = () => reject(Error('cancelled')); signal.addEventListener('abort', abort, { once: true });
  promise.then(v => { signal.removeEventListener('abort', abort); resolveValue(v); }, e => { signal.removeEventListener('abort', abort); reject(e); });
 });
}

export async function runPilot(options: Options): Promise<Result> {
 const result: Result = { status: 'blocked', rows: [], physicalAttempts: 0, taskAcceptance: 'not_recorded', canonicalSecurityAccuracyEligible: false };
 let release: (() => void) | undefined, budget: ReturnType<typeof createPilotBudget> | undefined;
 let finished = false, currentId = '', blocked = false;
 try {
  const live = options.mode === 'execute-live';
  if (!['dry-run', 'execute-injected', 'execute-live'].includes(options.mode ?? 'dry-run')) throw Error('live_not_supported');
  const root = resolve(options.directory); safePath(root);
  const texts = Object.fromEntries(dataFiles.map(f => [f, readLocal(join(root, f))]));
  const hashes = Object.fromEntries(dataFiles.map(f => [f, hash(texts[f])]));
  const corpus = JSON.parse(texts['examples.json']), labels = JSON.parse(texts['labels.json']), declared = JSON.parse(texts['outbound-preview.json']);
  checkCorpus(corpus, labels, declared);
  const requests = await previewBodies(corpus, root);
  for (let i = 0; i < 40; i++) if (JSON.stringify(requests[i].body) !== JSON.stringify(declared.requests[i].body)) throw Error('outbound_preview_changed');
  // Do not invent a valid price in an ordinary dry-run.
  let approval: any, pricing: any, extraTexts: Record<string, string> = {};
  if (options.mode === 'execute-injected' || live || additionalFiles.every(f => existsSync(join(root, f)))) {
   extraTexts = Object.fromEntries(additionalFiles.map(f => [f, readLocal(join(root, f))]));
   approval = JSON.parse(extraTexts['authorization.json']); pricing = JSON.parse(extraTexts['pricing.json']);
   checkAuthorization(approval, pricing, hashes, corpus, labels, live);
   result.budgetBasis = pricing.basis === 'human_approved_public_pricing_assumption' ? pricing.basis : 'externally_verified';
   result.binding = { pilotHash: hash(extraTexts['authorization.json']), corpusHash: hash(JSON.stringify(hashes)), pricingHash: hash(extraTexts['pricing.json']), maxAttemptMicrousd: pricing.maxAttemptMicrousd };
  }
  if (options.mode !== 'execute-injected' && !live) { result.status = 'dry_run'; result.requests = requests; return result; }
  if (live && (typeof options.apiKey !== 'string' || !options.apiKey.trim() || /[\s\x00-\x1f\x7f]/.test(options.apiKey))) throw Error('live_key_missing');
  const send = options.transport ?? (live ? defaultJevTransport : undefined);
  if (!send || !live && !options.attemptCostMicrousd || !options.ledgerPath || !result.binding) throw Error('injected_inputs_missing');
  const ids = options.exampleIds ?? requests.map(r => r.id);
  if (!ids.length || ids.length > 40 || new Set(ids).size !== ids.length || ids.some(id => !validId(id))) throw Error('invalid_example_selection');
  if (options.signal?.aborted) throw Error('cancelled');
  release = acquireRunLock(options.ledgerPath);
  budget = createPilotBudget({ ledgerPath: options.ledgerPath, binding: result.binding, create: options.initializeLedger === true });
  if (budget.snapshot().blocked) throw Error('budget_blocked');
  const recheck = () => {
   if (finished || blocked || options.signal?.aborted) throw Error('cancelled_or_blocked');
   for (const f of dataFiles) if (hash(readLocal(join(root, f))) !== hashes[f]) throw Error('approved_bytes_changed');
   for (const f of additionalFiles) if (readLocal(join(root, f)) !== extraTexts[f]) throw Error('approval_or_pricing_changed');
  };
  let pendingAttempt: { receipt: PilotAttempt; response?: JevHttpResponse } | undefined;
  const unknownAttempt = () => {
   if (!pendingAttempt) return;
   try { budget!.settle(pendingAttempt.receipt, null); } catch { /* Durable reservation/fence is retained. */ }
   pendingAttempt = undefined; blocked = true;
  };
  const knownAttempt = () => {
   if (!pendingAttempt?.response) throw Error('response_unavailable');
   const cost = live ? result.binding!.maxAttemptMicrousd : options.attemptCostMicrousd!(pendingAttempt.response);
   budget!.settle(pendingAttempt.receipt, cost);
   pendingAttempt = undefined;
   if (cost === null) { blocked = true; throw Error('unknown_cost'); }
  };
  const transport: JevTransport = async request => {
   try {
    recheck();
    // A retry invocation proves the adapter consumed the previous retryable body.
    // Settlement waits until this boundary, never just response headers.
    if (pendingAttempt) {
     if (live) throw Error('live_retry_refused'); // Unknown/error spend must stop, never auto-retry.
     knownAttempt();
    }
    const expected = requests.find(r => r.id === currentId);
    if (!expected || request.url !== JEV_ENDPOINT || request.method !== 'POST' || request.body.toString('utf8') !== JSON.stringify(expected.body)) throw Error('outbound_body_mismatch');
    pendingAttempt = { receipt: budget!.reserve(currentId, request.signal) };
    if (request.signal.aborted || options.signal?.aborted) throw Error('cancelled');
    // Let the adapter attach its abort/error handlers before an injected transport
    // can synchronously cancel the request. Count only actual invocation attempts.
    const response = await aborted(Promise.resolve().then(() => {
     if (request.signal.aborted || options.signal?.aborted || finished) throw Error('cancelled');
     recheck();
     result.physicalAttempts++;
     return send({ ...request, body: Buffer.from(request.body), headers: { ...request.headers } });
    }), request.signal);
    if (finished || request.signal.aborted || options.signal?.aborted) throw Error('cancelled');
    pendingAttempt.response = response;
    return response;
   } catch {
    unknownAttempt(); blocked = true;
    throw Error('pilot_transport_blocked'); // Never echo provider bodies/credentials/raw errors.
   }
  };
  const service = createSystem1Service({ provider: createJevProvider({ apiKey: live ? options.apiKey! : 'synthetic-injected-only', transport }) });
  for (const id of ids) {
   recheck(); currentId = id;
   const response = await service.evaluate({ state: requests.find(r => r.id === id)!.body.state, questions: TASK_TRIAGE_QUESTIONS, questionSetVersion: TASK_TRIAGE_QUESTION_VERSION, timeoutMs: 2000, signal: options.signal });
   result.rows.push({ id, status: response.status, assessment: assessTaskTriage(response) });
   if (response.status === 'ok' && !options.signal?.aborted && !blocked) {
    try { knownAttempt(); } catch { unknownAttempt(); throw Error('accounting_stopped'); }
   } else { unknownAttempt(); throw Error('evaluation_stopped'); }
   if (blocked) throw Error('accounting_stopped');
  }
  result.status = 'completed';
 } catch (error) {
  result.status = options.signal?.aborted ? 'cancelled' : 'blocked';
  result.reason = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'pilot_preflight_or_accounting_blocked';
 } finally {
  finished = true;
  if (budget) { try { result.budget = budget.snapshot(); } catch { result.status = 'blocked'; result.reason = 'ledger_unavailable'; } }
  if (release) { try { release(); } catch { result.status = 'blocked'; result.reason = 'run_lock_unavailable'; } }
 }
 return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 const args = process.argv.slice(2);
 if (args.length !== 2 || args[0] !== '--directory') { console.error('Usage: node bin/task-triage-pilot.ts --directory <local corpus directory>. Preview only; live flags are refused.'); process.exitCode = 1; }
 else {
  const result = await runPilot({ directory: args[1] });
  console.log(JSON.stringify(result)); process.exitCode = result.status === 'dry_run' ? 0 : 1;
 }
}
