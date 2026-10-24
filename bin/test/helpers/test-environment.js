// SDK fixtures must not borrow a surrounding Fleet session's role, capabilities,
// root transport, IPC assignment or path exemptions. This is test isolation only.
const ownedKey=key=>key.startsWith('AGENT_HUB_')||key==='AF_SESSION_ROOTS'||key.startsWith('AF_TARGET_');
export function isolatedFleetTestEnv(base=process.env){return Object.fromEntries(Object.entries(base).filter(([key])=>!ownedKey(key)));}
export function isolateFleetTestProcess(){
 const saved=Object.fromEntries(Object.entries(process.env).filter(([key])=>ownedKey(key)));
 for(const key of Object.keys(process.env))if(ownedKey(key))delete process.env[key];
 return ()=>{for(const key of Object.keys(process.env))if(ownedKey(key))delete process.env[key];Object.assign(process.env,saved);};
}
