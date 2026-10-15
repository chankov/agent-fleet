import test from 'node:test';
import assert from 'node:assert/strict';
import {bindSemanticScope,coveredDeletePath,deleteConfirmation,exactDeletePath,inspectionBash,noteSemanticDecision,resetSemanticApprovals,semanticAskUserAnswer,semanticDecision} from './semantic-approval.ts';

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

test('an affirmative delete question records one path and a repeat is not asked',()=>{
 resetSemanticApprovals();bindSemanticScope("task","rev");
 const question="Потвърждаваш ли изтриването на точно `docs/d6-activation-smoke-empty.txt`?";
 assert.deepEqual(deleteConfirmation(question,undefined,"Да, изтрий файла"),{path:"docs/d6-activation-smoke-empty.txt",decision:"allow"});
 noteSemanticDecision("task","rev","docs/d6-activation-smoke-empty.txt","allow");
 assert.equal(semanticAskUserAnswer({question,options:["Да, изтрий файла","Не, запази файла"]}),"Да, изтрий файла");
 noteSemanticDecision("task","rev","docs/d6-activation-smoke-empty.txt","deny");
 assert.equal(semanticAskUserAnswer({question,options:["Да, изтрий файла","Не, запази файла"]}),"Не, запази файла");
});
