import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { InstructionTransport } from '../../agent-fleet/scripts/lib/fleet-codex-instruction-transport.ts';
import { handleInstructionReceipt, ownerOf } from './coms-instruction-receipts.ts';
import { handleObservationEnvelope } from './coms-observation.ts';

// Compile ONLY the actual production factory expression and its owner accessor.
// Never import/run the whole hub extension; never substitute a copied options object.
const source = readFileSync(new URL('../agent-hub/index.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function matches(predicate: (node: ts.Node) => boolean): ts.Node[] {
    const result: ts.Node[] = [];
    const visit = (node: ts.Node) => { if (predicate(node)) result.push(node); ts.forEachChild(node, visit); };
    visit(ast);
    return result;
}
function productionFactory(dependencies: Record<string, unknown>): any {
    const declarations = matches(n => ts.isVariableDeclaration(n) && n.name.getText(ast) === 'coms'
        && !!n.initializer && ts.isCallExpression(n.initializer) && n.initializer.expression.getText(ast) === 'createComsPeer') as ts.VariableDeclaration[];
    const owners = matches(n => ts.isFunctionDeclaration(n) && n.name?.text === 'observationOwner') as ts.FunctionDeclaration[];
    assert.equal(declarations.length, 1, 'one actual embedded createComsPeer consumer');
    assert.equal(owners.length, 1, 'one actual embedded owner accessor');
    const body = `function make(deps:any) {
        const {pi,currentCtx,refreshFleetUi,createComsPeer,modelWorkBlockedByRosterRecovery,
            handleObservationEnvelope,handleInstructionReceipt,handleQuestionEnvelope,
            questionChannel,accessApprovalRouter}=deps;
        const coms=${declarations[0].initializer!.getText(ast)};
        ${owners[0].getText(ast)}
        return coms;
    }`;
    const compiled = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true });
    assert.equal(compiled.diagnostics?.length ?? 0, 0);
    return new Function(compiled.outputText + '\nreturn make;')()(dependencies);
}

test('embedded S6a imports the real receipt handler in the production consumer', () => {
    const imported = ast.statements.some(n => ts.isImportDeclaration(n)
        && ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text === '../lib/coms-instruction-receipts.ts'
        && n.importClause?.namedBindings && ts.isNamedImports(n.importClause.namedBindings)
        && n.importClause.namedBindings.elements.some(e => e.name.text === 'handleInstructionReceipt' && !e.propertyName));
    assert.equal(imported, true, 'actual factory must not rely on a test-only handler binding');
});

test('embedded S6a actual factory: capability, admission, receipts and unchanged existing routes', async t => {
    const root = await mkdtemp(join(tmpdir(), 'emb-'));
    const previousRoot = process.env.PI_COMS_DIR, previousHerdr = process.env.HERDR_ENV;
    process.env.PI_COMS_DIR = root;
    process.env.HERDR_ENV = '0';
    let peer: any;
    t.after(async () => {
        try { if (peer) await peer.shutdown(); }
        finally {
            if (previousRoot === undefined) delete process.env.PI_COMS_DIR; else process.env.PI_COMS_DIR = previousRoot;
            if (previousHerdr === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = previousHerdr;
            await rm(root, { recursive: true, force: true });
        }
    });
    const { createComsPeer, sendEnvelope } = await import(`./coms-core.ts?embedded=${Date.now()}`);
    const branch: any[] = [], delivered: string[] = [], routed: string[] = [];
    const append = (entry: Record<string, unknown>) => branch.push({ ...entry, id: String(branch.length), parentId: branch.length ? String(branch.length - 1) : null, timestamp: new Date().toISOString() });
    const sessionManager = { getBranch: () => branch, getLeafId: () => branch.at(-1)?.id ?? null, getEntry: (id: string) => branch[Number(id)] };
    const ctx: any = { cwd: root, model: { id: 'fixture' }, hasUI: false, getContextUsage: () => null, sessionManager,
        ui: { notify() {}, setWidget() {}, setStatus() {} } };
    const pi = {
        getFlag: (name: string) => name === 'name' ? 'orchestrator' : name === 'project' ? 'fixture' : undefined,
        getSessionName: () => undefined,
        appendEntry: (customType: string, data: unknown) => append({ type: 'custom', customType, data }),
        sendMessage: (message: any) => { delivered.push(message.details.msg_id); append({ type: 'custom_message', customType: message.customType, details: message.details }); },
    };
    let blocked = false;
    peer = productionFactory({ pi, currentCtx: ctx, createComsPeer, refreshFleetUi() {},
        modelWorkBlockedByRosterRecovery: () => blocked, handleObservationEnvelope, handleInstructionReceipt,
        questionChannel: { list: () => ({ status: 'available', partial: false, questions: [], resolved: [], nextCursor: null }) },
        handleQuestionEnvelope: (socket: any, envelope: any) => {
            if (envelope.type !== 'fixture_question') return false;
            routed.push('question'); socket.end(JSON.stringify({ type: 'fixture_response', msg_id: envelope.msg_id, route: 'question' }) + '\n'); return true;
        },
        accessApprovalRouter: { handle: (socket: any, envelope: any) => { routed.push('access'); socket.end(JSON.stringify({ type: 'fixture_response', msg_id: envelope.msg_id, route: 'access' }) + '\n'); } },
    });
    await peer.connect({ ctx, defaultNamePrefix: 'fixture', defaultPurpose: '' });
    assert.ok(peer.identity.endpoint.startsWith(root + '/'), 'only an owned temp socket may receive fixture packets');
    const owner = ownerOf(peer.identity), wire = 'f'.repeat(64);
    const transport = new InstructionTransport({ registryRoot: root, timeoutMs: 1500, resultWaitMs: 0 });
    const base: any = { sender_session: 'fixture-only', sender_endpoint: join(root, 'absent.sock'), hops: 0, timestamp: new Date().toISOString() };
    // This fails on the diagnosed missing production flag, not on a test replica.
    assert.equal(await transport.capability(owner), true);
    assert.deepEqual(delivered, []);

    await t.test('all exact owner dimensions refuse before enqueue', async () => {
        for (const bad of [{ ...owner, project: 'other' }, { ...owner, peer: 'other' }, { ...owner, sessionId: 'other' }, { ...owner, startedAt: '2026-01-01T00:00:00.000Z' }]) {
            await assert.rejects(() => sendEnvelope(peer.identity.endpoint, { ...base, type: 'prompt', msg_id: wire, prompt: 'isolated fixture', instruction: { version: 1, owner: bad } }), /owner/);
        }
        assert.deepEqual(delivered, []);
    });
    await t.test('one guarded temp prompt; actual computed receipt is owner/wire-correlated and redacted', async () => {
        let attempts = 0;
        const accepted = await transport.send(owner, wire, 'isolated fixture only', { beforeWrite: async () => { attempts++; } });
        assert.equal(attempts, 1); assert.equal(accepted.state, 'submitted'); assert.deepEqual(delivered, [wire]);
        append({ type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'thinking', thinking: 'PRIVATE_THINKING' }, { type: 'text', text: 'token=SECRET EMBEDDED_OK' }] } });
        await peer.settleTurn(ctx);
        const receipt = await transport.receipt(owner, wire);
        assert.ok(receipt); assert.deepEqual(receipt.owner, owner); assert.equal(receipt.wireId, wire); assert.equal(receipt.state, 'result');
        assert.ok(receipt.text?.includes('EMBEDDED_OK')); assert.equal(JSON.stringify(receipt).includes('SECRET'), false); assert.equal(JSON.stringify(receipt).includes('PRIVATE_THINKING'), false);
        assert.ok(Buffer.byteLength(receipt.text ?? '') <= 4096);
        assert.equal(await transport.receipt(owner, 'e'.repeat(64)), null);
        const stale = await sendEnvelope(peer.identity.endpoint, { type: 'instruction_receipt_request', version: 1, msg_id: 'stale-receipt', owner: { ...owner, sessionId: 'other' }, wireId: wire, sender_session: base.sender_session, sender_endpoint: '' });
        assert.equal(stale.status, 'stale'); assert.equal(stale.receipt, null);
        assert.deepEqual(delivered, [wire]);
    });
    await t.test('observation/question/access routing still uses the existing production chain', async () => {
        const snapshot = await sendEnvelope(peer.identity.endpoint, { sender_session: base.sender_session, sender_endpoint: base.sender_endpoint, type: 'observation_request', version: 1, msg_id: 'observe', operation: 'snapshot', owner });
        assert.equal(snapshot.type, 'observation_response'); assert.equal(snapshot.status, 'available');
        const question = await sendEnvelope(peer.identity.endpoint, { ...base, type: 'fixture_question', msg_id: 'question' });
        const access = await sendEnvelope(peer.identity.endpoint, { ...base, type: 'access_request', msg_id: 'access' });
        assert.equal(question.route, 'question'); assert.equal(access.route, 'access'); assert.deepEqual(routed, ['question', 'access']);
        assert.deepEqual(delivered, [wire]);
    });
    await t.test('existing roster recovery refusal and legacy prompt behavior remain', async () => {
        blocked = true;
        await assert.rejects(() => sendEnvelope(peer.identity.endpoint, { ...base, type: 'prompt', msg_id: 'blocked', prompt: 'blocked fixture' }), /roster recovery/);
        await assert.rejects(() => sendEnvelope(peer.identity.endpoint, { ...base, type: 'prompt', msg_id: 'd'.repeat(64), prompt: 'blocked native fixture', instruction: { version: 1, owner } }), /roster recovery/);
        assert.deepEqual(delivered, [wire]);
        blocked = false;
        await sendEnvelope(peer.identity.endpoint, { ...base, type: 'prompt', msg_id: 'legacy', prompt: 'legacy fixture' });
        assert.deepEqual(delivered, [wire, 'legacy']);
    });
});
