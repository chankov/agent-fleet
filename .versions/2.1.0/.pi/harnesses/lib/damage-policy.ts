import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {createRequire} from 'node:module';
// Legacy/native adapters can load without optional policy dependencies. Targeted
// policy evaluation still requires the workspace's installed YAML parser.
const require=createRequire(import.meta.url);
import { safeSourceRead } from './safe-source-read.js';
import { sessionRootsFromEnv } from './workspace-context.ts';
export interface DamagePolicy {
 bashToolPatterns: {pattern:string;reason:string;ask?:boolean}[];
 zeroAccessPaths:string[];readOnlyPaths:string[];noDeletePaths:string[];
}
/** The policy source is workspace-owned; path matching remains execution-relative. */
export function readDamagePolicy(execution:string,roots=sessionRootsFromEnv()): {path:string;rules:DamagePolicy;digest:string} | undefined {
 const strict=roots?.mode==='targeted';
 const base=roots?.workspaceRoot??execution;
 const project=join(base,'.pi/damage-control-rules.yaml'), global=join(homedir(),'.pi/damage-control-rules.yaml');
 const selected=existsSync(project)?project:!strict&&existsSync(global)?global:undefined;
 if(!selected){if(strict)throw new Error('missing_workspace_damage_policy');return undefined;}
 const bytes=safeSourceRead(selected===project?base:homedir(),selected,1024*1024);
 let value:any;try{value=require('yaml').parse(bytes.toString('utf8'));}catch{throw new Error('invalid_damage_policy:yaml');}
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid_damage_policy');
 for(const key of ['bashToolPatterns','zeroAccessPaths','readOnlyPaths','noDeletePaths']) {
  if(value[key]===undefined&&!strict)value[key]=[];
  if(!Array.isArray(value[key]))throw new Error(`invalid_damage_policy:${key}`);
 }
 for(const key of ['zeroAccessPaths','readOnlyPaths','noDeletePaths'])if(value[key].some((p:unknown)=>typeof p!=='string'||!p))throw new Error(`invalid_damage_policy:${key}`);
 for(const rule of value.bashToolPatterns){
  if(!rule||typeof rule.pattern!=='string'||!rule.pattern||typeof rule.reason!=='string'||(rule.ask!==undefined&&typeof rule.ask!=='boolean'))throw new Error('invalid_damage_policy:bashToolPatterns');
  try{new RegExp(rule.pattern);}catch{throw new Error('invalid_damage_policy:pattern');}
 }
 return {path:selected,rules:value as DamagePolicy,digest:createHash('sha256').update(bytes).digest('hex')};
}
