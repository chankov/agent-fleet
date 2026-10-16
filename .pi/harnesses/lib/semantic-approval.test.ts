import test from 'node:test';
import assert from 'node:assert/strict';
import {bindSemanticScope,coveredDeletePath,exactDeletePath,inspectionBash,noteBashDecision,noteSemanticDecision,resetSemanticApprovals,semanticDecision} from './semantic-approval.ts';

test('inspection is silent, while only an exact approved delete is reused',()=>{
 resetSemanticApprovals();
 assert.equal(inspectionBash("pwd; ls -l docs/d6-activation-smoke-empty.txt 2>/dev/null"),true);
 assert.equal(inspectionBash("rm -- docs/d6-activation-smoke-empty.txt"),false);
 assert.equal(exactDeletePath("rm -- docs/d6-activation-smoke-empty.txt"),"docs/d6-activation-smoke-empty.txt");
 assert.equal(exactDeletePath("rm -rf docs/d6-activation-smoke-empty.txt"),null);
 assert.equal(coveredDeletePath("rm -- docs/d6-activation-smoke-empty.txt && test ! -e docs/d6-activation-smoke-empty.txt"),"docs/d6-activation-smoke-empty.txt");
 assert.equal(coveredDeletePath("rm -- docs/a && rm -- docs/b"),null);
 assert.equal(exactDeletePath("rm -- docs/a docs/b"),null);
 noteSemanticDecision("task","rev","docs/d6-activation-smoke-empty.txt","allow");
 assert.equal(semanticDecision("task","rev","docs/d6-activation-smoke-empty.txt"),"allow");
 assert.equal(semanticDecision("task","rev","docs/other.txt"),undefined);
 assert.equal(semanticDecision("task","other","docs/d6-activation-smoke-empty.txt"),undefined);
});

test('a newline or another control character never hides a second command',()=>{
 for(const command of ['ls\nrm -rf important','ls\rrm -rf important','pwd\u0085rm -rf important','ls\u0000;rm x'])assert.equal(inspectionBash(command),false,JSON.stringify(command));
 assert.equal(inspectionBash('ls -l docs/a\n'),true);
 assert.equal(coveredDeletePath('rm -- docs/a\nrm -rf docs'),null);
 assert.equal(coveredDeletePath('test -e docs/a\nrm -rf docs && rm -- docs/a'),null);
 assert.equal(exactDeletePath('rm -- docs/a\u0000'),null);
});

test('only an exact command dialog records a delete decision, and only for the bound revision',()=>{
 resetSemanticApprovals();bindSemanticScope('task','one');
 noteBashDecision('task','one','rm -- docs/empty.txt && test ! -e docs/empty.txt','allow');
 assert.equal(semanticDecision('task','one','docs/empty.txt'),'allow');
 noteBashDecision('task','one','rm -rf docs','allow');noteBashDecision('task','one','ls\nrm -- docs/other.txt','allow');
 assert.equal(semanticDecision('task','one','docs'),undefined);assert.equal(semanticDecision('task','one','docs/other.txt'),undefined);
 bindSemanticScope('task','two');assert.equal(semanticDecision('task','one','docs/empty.txt'),undefined);
 resetSemanticApprovals();
});
