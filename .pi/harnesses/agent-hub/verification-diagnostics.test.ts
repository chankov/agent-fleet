import assert from 'node:assert/strict';
import test from 'node:test';
import { verificationDiagnostics, verificationDiagnosticNotice } from './verification-diagnostics.ts';

const requirements:any[]=[
 {id:'A1',tag:'test',source:'human',testCommand:'test-exact',compilerCommand:'compile-exact'},
 {id:'A7',tag:'test',source:'human',testCommand:'test-exact'},
 {id:'M1',tag:'manual',source:'human'},
];
test('missing receipts name declared commands and all covered requirements, not observed payloads',()=>{
 const result=verificationDiagnostics(requirements,[{command:'test-exact; echo PRIVATE_PAYLOAD'}],[]);
 assert.deepEqual(result,{observedCommandCount:1,missingExactCommands:[{command:'test-exact',requirementIds:['A1','A7']},{command:'compile-exact',requirementIds:['A1']}]});
 assert.doesNotMatch(JSON.stringify(result)+verificationDiagnosticNotice(result),/PRIVATE_PAYLOAD/);
});
test('observed failures and recorded receipts are not misreported as unobserved commands',()=>{
 const result=verificationDiagnostics(requirements,[{command:'test-exact'}],[{producer:'runtime',command:['compile-exact'],exitCode:1} as any]);
 assert.deepEqual(result.missingExactCommands,[]);
 assert.equal(verificationDiagnosticNotice(result),null);
});
test('model-produced check cannot suppress missing runtime command diagnostic',()=>{
 const result=verificationDiagnostics(requirements,[],[{producer:'specialist',command:['test-exact']} as any]);
 assert.equal(result.missingExactCommands.length,2);
});
