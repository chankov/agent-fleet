import test from 'node:test';import assert from 'node:assert/strict';
import {validateAgenticInput} from './agentic-contract.ts';
const questions=[{id:'bug',type:'choice',instructions:'Classify',options:{bug:null,unknown:null}},{id:'pass',type:'predicate',instructions:'Passed?'},{id:'risk',type:'ordinal',instructions:'Risk',levels:['low','high']}];
test('typed batch and UTF8 byte validation',()=>{
 assert.equal(validateAgenticInput({state:'Заявка',questions}).ok,true);
 for(const v of [{questions},{state:'x',questions:[{...questions[0],options:{bug:null,expected:null}}]},{state:'x',questions:[questions[1],questions[1]]},{state:'x',questions,command:'true'},{state:'x',questions,provider:'evil'},{state:'x',questions:[{...questions[1],confidence:1}]}]) assert.equal(validateAgenticInput(v).ok,false);
 assert.equal(validateAgenticInput({state:'я'.repeat(4096),questions}).ok,false);
 assert.equal(validateAgenticInput({state:'password=abc',questions}).ok,false);
 const v:any={state:{},questions};v.state.self=v.state;assert.equal(validateAgenticInput(v).ok,false);
});
