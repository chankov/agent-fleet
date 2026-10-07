import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { runPilot } from '../task-triage-pilot.ts';
import { createPilotBudget } from '../lib/task-triage-pilot-budget.ts';
import { TASK_TRIAGE_QUESTIONS } from '../../.pi/harnesses/agent-hub/task-triage-contract.ts';

const corpusRoot = new URL('./fixtures/task-triage-pilot/', import.meta.url);
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
function fixture(t: any) {
 const dir = mkdtempSync(join(tmpdir(), 'pilot-runner-'));
 t.after(() => rmSync(dir, { recursive: true, force: true }));
 const data = join(dir, 'data'); mkdirSync(data);
 for (const file of ['examples.json', 'labels.json', 'outbound-preview.json']) writeFileSync(join(data, file), readFileSync(new URL(file, corpusRoot)));
 const labels = JSON.parse(readFileSync(join(data, 'labels.json'), 'utf8'));
 for (const e of labels.examples) e.split = Number(e.id.slice(1)) <= 20 ? 'development' : 'held-out';
 writeFileSync(join(data, 'labels.json'), JSON.stringify(labels));
 const hashes = Object.fromEntries(['examples.json', 'labels.json', 'outbound-preview.json'].map(f => [f, hash(readFileSync(join(data, f), 'utf8'))]));
 const approval = { schema: 'task-triage-pilot-authorization/v1', approvedByHuman: true, technicalAccepted: true, execution: 'injected-test', hashes,
  groups: [{ id: 'group-a', ids: labels.examples.slice(0, 20).map((e: any) => e.id), split: 'development' }, { id: 'group-b', ids: labels.examples.slice(20).map((e: any) => e.id), split: 'held-out' }] };
 const pricing = { schema: 'task-triage-pilot-pricing/v1', currency: 'USD', maxAttemptMicrousd: 50000, externallyVerified: true, evidence: 'SYNTHETIC TEST ONLY: fixed upper bound' };
 writeFileSync(join(data, 'authorization.json'), JSON.stringify(approval));
 writeFileSync(join(data, 'pricing.json'), JSON.stringify(pricing));
 return { dir, data, ledger: join(dir, 'ledger.ndjson'), pricing, approval };
}
const okResponse = () => ({ status: 200, headers: {}, body: JSON.stringify({ model: 'jev-1.13.0', usage: { input_tokens: 10, output_tokens: 2 }, answers: Object.fromEntries(TASK_TRIAGE_QUESTIONS.map(q => [q.id, { type: 'noul', noul: q.id === 'wide_change' ? 0.9 : 0.1 }])) }) });
const execute = (f: ReturnType<typeof fixture>, extra: any = {}) => runPilot({ directory: f.data, mode: 'execute-injected', ledgerPath: f.ledger, initializeLedger: true,
 exampleIds: ['P01'], attemptCostMicrousd: () => 10000, transport: async () => okResponse(), ...extra });

test('pilot default dry-run builds exactly 40 production request bodies without transport, ledger or config writes', async t => {
 const f = fixture(t); let sends = 0;
 const result = await runPilot({ directory: f.data, transport: async () => { sends++; return okResponse(); } });
 assert.equal(result.status, 'dry_run'); assert.equal(result.requests?.length, 40); assert.equal(sends, 0); assert.equal(existsSync(f.ledger), false);
 for (const row of result.requests!) { assert.deepEqual(Object.keys(row.body).sort(), ['model', 'questions', 'state']); assert.equal(JSON.stringify(row.body).includes('sourceRefs'), false); }
});

test('injected runner persists every physical reservation before transport and reports assessment not task acceptance', async t => {
 const f = fixture(t); const bodies: string[] = [];
 const result = await execute(f, { exampleIds: ['P01', 'P02'], transport: async (request: any) => {
  assert.match(readFileSync(f.ledger, 'utf8'), /"kind":"reserve"/); bodies.push(request.body.toString()); return okResponse();
 } });
 assert.equal(result.status, 'completed'); assert.equal(result.physicalAttempts, 2); assert.equal(result.rows.length, 2);
 assert.equal(result.rows[0].assessment.status, 'applied'); assert.deepEqual(result.rows[0].assessment.reasons, ['wide_change']);
 assert.equal(result.taskAcceptance, 'not_recorded'); assert.equal(result.canonicalSecurityAccuracyEligible, false);
 assert.equal(result.budget!.chargedMicrousd, 20000); assert.ok(!JSON.stringify(result.rows).includes('synthetic-test'));
 assert.equal(bodies.length, 2);
});

test('adapter retry requires a second durable reservation and cannot straddle physical or USD caps', async t => {
 for (const cap of ['none', 'physical', 'USD']) {
  const f = fixture(t); let sends = 0;
  const dry = await runPilot({ directory: f.data });
  const binding = dry.binding!;
  if (cap === 'physical') { const b = createPilotBudget({ ledgerPath: f.ledger, binding, create: true }); for (let i = 0; i < 99; i++) { const r = b.reserve('P01'); b.settle(r, 1); } }
  if (cap === 'USD') { const b = createPilotBudget({ ledgerPath: f.ledger, binding, create: true }); for (let i = 0; i < 99; i++) { const r = b.reserve('P01'); b.settle(r, 50000); } }
  const result = await execute(f, { initializeLedger: cap === 'none', attemptCostMicrousd: () => 50000,
   transport: async () => { sends++; return sends === 1 ? { status: 429, headers: { 'retry-after': '0' }, body: '{}' } : okResponse(); } });
  assert.equal(sends, cap === 'none' ? 2 : 1);
  assert.equal(result.status, cap === 'none' ? 'completed' : 'blocked');
  assert.equal(result.physicalAttempts, sends);
 }
});

test('missing approval/price, changed bytes, split leakage or unapproved live mode sends nothing', async t => {
 for (const variant of ['approval', 'price', 'bytes', 'split', 'live']) {
  const f = fixture(t); let sends = 0;
  if (variant === 'approval') rmSync(join(f.data, 'authorization.json'));
  if (variant === 'price') rmSync(join(f.data, 'pricing.json'));
  if (variant === 'bytes') writeFileSync(join(f.data, 'labels.json'), readFileSync(join(f.data, 'labels.json'), 'utf8') + ' ');
  if (variant === 'split') { const labels = JSON.parse(readFileSync(join(f.data, 'labels.json'), 'utf8')); labels.examples[1].split = 'held-out'; writeFileSync(join(f.data, 'labels.json'), JSON.stringify(labels)); f.approval.hashes['labels.json'] = hash(readFileSync(join(f.data, 'labels.json'), 'utf8')); writeFileSync(join(f.data, 'authorization.json'), JSON.stringify(f.approval)); }
  const result = await execute(f, { mode: variant === 'live' ? 'live' : 'execute-injected', transport: async () => { sends++; return okResponse(); } });
  assert.equal(result.status, 'blocked'); assert.equal(sends, 0); assert.equal(existsSync(f.ledger), false);
 }
});

test('unknown cost, network failure, cancellation and late callback retain conservative spend and block restart', async t => {
 for (const variant of ['unknown', 'network', 'cancel']) {
  const f = fixture(t); let sends = 0; const controller = new AbortController();
  const result = await execute(f, { signal: controller.signal, attemptCostMicrousd: () => variant === 'unknown' ? null : 1,
   transport: async () => { sends++; if (variant === 'network') throw Error('PRIVATE_PROVIDER_ERROR'); if (variant === 'cancel') { controller.abort(); await new Promise(r => setTimeout(r, 10)); } return okResponse(); } });
  assert.ok(['blocked', 'cancelled'].includes(result.status)); assert.equal(sends, 1); assert.equal(result.budget!.reservedMicrousd, 50000); assert.equal(result.budget!.blocked, true);
  await new Promise(r => setTimeout(r, 20));
  const restart = await execute(f, { initializeLedger: false, transport: async () => { sends++; return okResponse(); } });
  assert.equal(restart.status, 'blocked'); assert.equal(sends, 1); assert.ok(!JSON.stringify(result).includes('PRIVATE_PROVIDER_ERROR'));
 }
});

test('streamed response cancelled after headers does not release a reservation as known spend', async t => {
 const f = fixture(t), controller = new AbortController(); let costs = 0;
 const result = await execute(f, { signal: controller.signal, attemptCostMicrousd: () => { costs++; return 1; },
  transport: async () => ({ status: 200, headers: {}, body: (async function* () {
   controller.abort(); await new Promise(resolve => setTimeout(resolve, 10)); yield Buffer.from(okResponse().body);
  })() }) });
 assert.equal(result.status, 'cancelled'); assert.equal(costs, 0, 'headers alone cannot establish complete response cost');
 assert.equal(result.budget!.reservedMicrousd, 50000); assert.equal(result.budget!.blocked, true);
});

test('exhausted, missing or corrupt ledger refuses before any injected send', async t => {
 for (const variant of ['physical', 'USD', 'missing', 'corrupt']) {
  const f = fixture(t); let sends = 0;
  const binding = (await runPilot({ directory: f.data })).binding!;
  if (variant !== 'missing') {
   const budget = createPilotBudget({ ledgerPath: f.ledger, binding, create: true });
   for (let i = 0; i < 100; i++) { const receipt = budget.reserve('P01'); budget.settle(receipt, variant === 'USD' ? 50000 : 0); }
   if (variant === 'corrupt') writeFileSync(f.ledger, readFileSync(f.ledger, 'utf8') + '{');
  }
  const result = await execute(f, { initializeLedger: false, transport: async () => { sends++; return okResponse(); } });
  assert.equal(result.status, 'blocked'); assert.equal(sends, 0); assert.equal(result.physicalAttempts, 0);
 }
});

test('invalid response or body timeout preserves unknown reservation rather than assuming cost', async t => {
 for (const variant of ['invalid', 'timeout']) {
  const f = fixture(t); let costs = 0;
  const result = await execute(f, { attemptCostMicrousd: () => { costs++; return 1; },
   transport: async () => ({ status: 200, headers: {}, body: variant === 'invalid' ? '{}' : {
    [Symbol.asyncIterator]() { return { next: () => new Promise<IteratorResult<Uint8Array>>(() => {}), return: async () => ({ done: true as const, value: undefined }) }; },
   } }) });
  assert.equal(result.status, 'blocked'); assert.equal(costs, 0); assert.equal(result.budget!.blocked, true); assert.equal(result.budget!.reservedMicrousd, 50000);
 }
});

test('concurrent runner is refused and payload mutation between attempts blocks next transport', async t => {
 const f = fixture(t); let sends = 0; let wake!: () => void;
 const first = execute(f, { exampleIds: ['P01', 'P02'], transport: async () => { sends++; if (sends === 1) await new Promise<void>(r => { wake = r; }); return okResponse(); } });
 while (!wake) await new Promise(r => setTimeout(r, 5));
 const second = await execute(f, { initializeLedger: false, transport: async () => { sends++; return okResponse(); } }); assert.equal(second.status, 'blocked');
 writeFileSync(join(f.data, 'outbound-preview.json'), readFileSync(join(f.data, 'outbound-preview.json'), 'utf8') + ' '); wake();
 const result = await first; assert.equal(result.status, 'blocked'); assert.equal(sends, 1);
});

test('live gate refuses test approval and screenshot-only pricing before transport or ledger creation', async t => {
 const f = fixture(t); let sends = 0;
 for (const variant of ['test-approval', 'unverified-price']) {
  if (variant === 'unverified-price') {
   (f.approval as any).execution = 'live'; (f.approval as any).endpoint = 'https://api.typesafe.ai/v1/systemone';
   (f.approval as any).model = 'jev-1.13.0';
   writeFileSync(join(f.data, 'authorization.json'), JSON.stringify(f.approval));
  }
  const r = await runPilot({ directory: f.data, mode: 'execute-live', apiKey: 'synthetic-live-key',
   transport: async () => { sends++; return okResponse(); }, ledgerPath: f.ledger, initializeLedger: true } as any);
  assert.equal(r.status, 'blocked');
  assert.equal(r.reason, variant === 'test-approval' ? 'approval_missing_or_changed' : 'live_billing_bound_unverified');
  assert.equal(sends, 0); assert.equal(existsSync(f.ledger), false);
 }
});

function liveFixture(t: any) {
 const f = fixture(t);
 Object.assign(f.approval, { execution: 'live', endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-1.13.0' });
 Object.assign(f.pricing, { billingBound: 'all_physical_attempts_including_errors', verificationSource: 'provider_terms', accountTermsConfirmed: true });
 writeFileSync(join(f.data, 'authorization.json'), JSON.stringify(f.approval));
 writeFileSync(join(f.data, 'pricing.json'), JSON.stringify(f.pricing));
 return f;
}

test('live path uses explicit key and full conservative charge; never trusts injected cost callback', async t => {
 const f = liveFixture(t); let sends = 0;
 const r = await runPilot({ directory: f.data, mode: 'execute-live', apiKey: 'synthetic-live-key',
  ledgerPath: f.ledger, initializeLedger: true, exampleIds: ['P01', 'P02'], attemptCostMicrousd: () => 0,
  transport: async request => { sends++; assert.equal(request.headers.Authorization ?? request.headers.authorization, 'Bearer synthetic-live-key');
   assert.match(readFileSync(f.ledger, 'utf8'), /"kind":"reserve"/); return okResponse(); } } as any);
 assert.equal(r.status, 'completed'); assert.equal(sends, 2); assert.equal(r.budget?.chargedMicrousd, 100000);
 assert.equal(JSON.stringify(r).includes('synthetic-live-key'), false);
});

test('live retryable error stops after one physical attempt with unknown spend and no restart', async t => {
 const f = liveFixture(t); let sends = 0;
 const options: any = { directory: f.data, mode: 'execute-live', apiKey: 'synthetic-live-key', ledgerPath: f.ledger,
  initializeLedger: true, exampleIds: ['P01'], transport: async () => { sends++; return { status: 429, headers: { 'retry-after': '0' }, body: '{}' }; } };
 const r = await runPilot(options); assert.equal(r.status, 'blocked'); assert.equal(sends, 1);
 assert.equal(r.budget?.blocked, true); assert.equal(r.budget?.reservedMicrousd, 50000);
 const again = await runPilot({ ...options, initializeLedger: false }); assert.equal(again.status, 'blocked'); assert.equal(sends, 1);
});

test('live requires an explicit key and rejects caller input lacking bound verification', async t => {
 const f = liveFixture(t); let sends = 0;
 const r = await runPilot({ directory: f.data, mode: 'execute-live', ledgerPath: f.ledger, initializeLedger: true,
  transport: async () => { sends++; return okResponse(); } } as any);
 assert.equal(r.status, 'blocked'); assert.equal(r.reason, 'live_key_missing'); assert.equal(sends, 0); assert.equal(existsSync(f.ledger), false);
});

test('explicit maintainer-approved public pricing assumption is honestly marked and charged conservatively', async t => {
 const f = liveFixture(t);
 const pricing: any = { schema: 'task-triage-pilot-pricing/v1', currency: 'USD', externallyVerified: false,
  basis: 'human_approved_public_pricing_assumption', humanApproved: true,
  maxInputTokens: 65536, inputMicrousdPerMillionTokens: 42000, outputMicrousdPerMillionTokens: 0,
  maxAttemptMicrousd: 2753, evidence: 'https://docs.typesafe.ai/models.md' };
 Object.assign(f.approval, { pricingAssumptionAccepted: true });
 writeFileSync(join(f.data, 'authorization.json'), JSON.stringify(f.approval));
 writeFileSync(join(f.data, 'pricing.json'), JSON.stringify(pricing));
 let sends = 0;
 const r = await runPilot({ directory: f.data, mode: 'execute-live', apiKey: 'synthetic-live-key',
  ledgerPath: f.ledger, initializeLedger: true, exampleIds: ['P01'], transport: async () => { sends++; return okResponse(); } });
 assert.equal(r.status, 'completed'); assert.equal(sends, 1); assert.equal(r.budget?.chargedMicrousd, 2753);
 assert.equal((r as any).budgetBasis, 'human_approved_public_pricing_assumption');
});

test('public pricing assumption rejects missing consent, invented prices or a falsely verified label', async t => {
 for (const variant of ['consent', 'price', 'verified', 'bound']) {
  const f = liveFixture(t); let sends = 0;
  const p: any = { schema: 'task-triage-pilot-pricing/v1', currency: 'USD', externallyVerified: variant === 'verified',
   basis: 'human_approved_public_pricing_assumption', humanApproved: true,
   maxInputTokens: 65536, inputMicrousdPerMillionTokens: 42000, outputMicrousdPerMillionTokens: 0,
   maxAttemptMicrousd: variant === 'bound' ? 1 : 2753, evidence: 'https://docs.typesafe.ai/models.md' };
  if (variant === 'price') p.inputMicrousdPerMillionTokens = 1;
  Object.assign(f.approval, { pricingAssumptionAccepted: variant !== 'consent' });
  writeFileSync(join(f.data, 'authorization.json'), JSON.stringify(f.approval)); writeFileSync(join(f.data, 'pricing.json'), JSON.stringify(p));
  const r = await runPilot({ directory: f.data, mode: 'execute-live', apiKey: 'synthetic-live-key', ledgerPath: f.ledger,
   initializeLedger: true, transport: async () => { sends++; return okResponse(); } });
  assert.equal(r.status, 'blocked'); assert.equal(sends, 0); assert.equal(existsSync(f.ledger), false);
 }
});

test('default CLI only previews local proposed corpus and rejects execution flags without reading keys', t => {
 const f = fixture(t); const cli = new URL('../task-triage-pilot.ts', import.meta.url).pathname;
 for (const live of [false, true]) {
  const result = spawnSync(process.execPath, [cli, '--directory', f.data, ...(live ? ['--live'] : [])], { encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH!, HOME: f.dir, PI_OFFLINE: '1' } });
  assert.equal(result.status, live ? 1 : 0, result.stderr); if (!live) assert.equal(JSON.parse(result.stdout).status, 'dry_run'); assert.equal(existsSync(f.ledger), false);
 }
});
