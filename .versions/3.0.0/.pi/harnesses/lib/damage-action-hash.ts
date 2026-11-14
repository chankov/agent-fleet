import {createHash} from 'node:crypto';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
function canonical(value:any,seen=new Set<object>()):any{
 if(value===null||typeof value==='string'||typeof value==='boolean')return value;
 if(typeof value==='number'){if(!Number.isFinite(value))throw Error('non_json_input');return value;}
 if(typeof value!=='object')throw Error('non_json_input');
 if(seen.has(value))throw Error('cyclic_input');seen.add(value);
 try{
  if(Array.isArray(value))return value.map(v=>canonical(v,seen));
  if(![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error('non_json_input');
  return Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,canonical(value[k],seen)]));
 }finally{seen.delete(value);}
}
/** Full JSON input identity is independent of object-key order, not of field values. */
export function damageActionHashes(operation:string,input:unknown):{target:string;legacyTargets:readonly string[]}{
 const target=sha(JSON.stringify(canonical(input))),legacy=new Set<string>();
 // Compatibility for the previously unwired v1 helpers' raw JSON hashes.
 // Only the small, known native scalar argument shapes are enumerated.
 const fields=operation==='bash'?['command','timeout']:operation==='write'?['path','content']:operation==='edit'?['path','oldText','newText']:[];
 if(input&&typeof input==='object'&&!Array.isArray(input)){
  const row=input as Record<string,unknown>,keys=Object.keys(row);
  if(keys.length&&keys.every(k=>fields.includes(k))){
   const visit=(prefix:string[],remaining:string[])=>{if(!remaining.length){legacy.add(sha(JSON.stringify(Object.fromEntries(prefix.map(k=>[k,row[k]])))));return;}for(const key of remaining)visit([...prefix,key],remaining.filter(k=>k!==key));};
   visit([],keys);
  }
 }
 return {target,legacyTargets:Object.freeze([...legacy].filter(h=>h!==target).sort())};
}
