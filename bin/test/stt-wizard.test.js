import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEnvPlaceholders, renderSttConfig, validateSttConfig } from "../lib/stt-wizard.js";
test("STT config contains env names but never secret values",()=>{
 const text=renderSttConfig({provider:"openai",apiKeyEnv:"OPENAI_API_KEY"}); assert.match(text,/OPENAI_API_KEY/); assert.doesNotMatch(text,/sk-/);
 assert.throws(()=>validateSttConfig({provider:"openai",apiKeyEnv:"OPENAI_API_KEY",apiKey:"sk-secret"}),/must not store/);
});
test("env placeholders append without overwriting values",()=>{
 const root=mkdtempSync(join(tmpdir(),"af-stt-")); writeFileSync(join(root,".env"),"OPENAI_API_KEY=keep\nOTHER=yes\n");
 const result=appendEnvPlaceholders(root,{apiKeyEnv:"OPENAI_API_KEY",endpointEnv:"AZURE_OPENAI_ENDPOINT"}); assert.match(result.text,/OPENAI_API_KEY=keep/); assert.match(result.text,/AZURE_OPENAI_ENDPOINT=\n/);
});
