#!/usr/bin/env node
// Fixed native STDIO bootstrap. Node's automatic TS stripping rejects node_modules;
// strip only this distribution's trusted .pi sources, never user-selected code.
import {registerHooks, stripTypeScriptTypes} from 'node:module';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve, sep} from 'node:path';

try {
  const sourceRoot=resolve(fileURLToPath(new URL('../../',import.meta.url)))+sep;
  registerHooks({
    load(url,context,nextLoad){
      if(url.startsWith('file:')){
        const filename=fileURLToPath(url);
        if(filename.startsWith(sourceRoot)&&filename.endsWith('.ts')){
          return {format:'module',source:stripTypeScriptTypes(readFileSync(filename,'utf8'),{mode:'strip',sourceUrl:url}),shortCircuit:true};
        }
      }
      return nextLoad(url,context);
    },
  });
  await import('./fleet-codex-local-mcp.ts');
} catch {
  process.stderr.write('LOCAL_MCP_START_FAILED\n');
  process.exitCode=1;
}
