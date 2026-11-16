// Pure independent configuration. Missing consent never inherits another consumer's scopes.
export const DAMAGE_GUARD_LIMITS = Object.freeze({
 maxPayloadBytes:16384, hookTimeoutMs:2000, maxFrameBytes:65536,
 outageBackoffMs:5000, approvalTimeoutMs:600000,
});
/** @param {unknown} value */
export function parseDamageGuardConfig(value) {
 /** @param {unknown} v */
 const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
 if (!record(value)) throw Error('Invalid damageGuard section');
 const section = /** @type {Record<string, any>} */ (value);
 if (Object.keys(section).some(k => !['mode','remoteScopes','include','limits'].includes(k)) || !['off','active'].includes(section.mode)) throw Error('Invalid damageGuard section');
 const suppliedScopes = section.remoteScopes ?? {};
 if (!record(suppliedScopes) || Object.entries(suppliedScopes).some(([k,v]) => !['commands','edits','results'].includes(k) || typeof v !== 'boolean')) throw Error('Invalid damageGuard scopes');
 const remoteScopes = {commands:suppliedScopes.commands === true,edits:suppliedScopes.edits === true,results:suppliedScopes.results === true};
 const include = section.include ?? [];
 if (!Array.isArray(include) || include.length > 20 || include.some(p => typeof p !== 'string' || !p || p.length > 1024 || (p.startsWith('git:') && p !== 'git:tracked') || /[\\\0*?:]/.test(p === 'git:tracked' ? '' : p) || p.startsWith('/') || p.replace(/\/$/,'').split('/').some(s => !s || s === '.' || s === '..'))) throw Error('Invalid include scope');
 if (section.mode === 'active' && Object.values(remoteScopes).some(Boolean) && !include.length) throw Error('Explicit include scope required');
 const supplied = section.limits ?? {};
 if (!record(supplied) || Object.keys(supplied).some(k => !Object.hasOwn(DAMAGE_GUARD_LIMITS,k))) throw Error('Invalid damageGuard limits');
 const limits = {...DAMAGE_GUARD_LIMITS,...supplied};
 if (Object.entries(limits).some(([k,n]) => !Number.isSafeInteger(n) || n <= 0 || n > DAMAGE_GUARD_LIMITS[/** @type {keyof typeof DAMAGE_GUARD_LIMITS} */ (k)])) throw Error('Invalid damageGuard limits');
 return {mode:/** @type {'off'|'active'} */ (section.mode),remoteScopes,include:[...include],limits};
}
