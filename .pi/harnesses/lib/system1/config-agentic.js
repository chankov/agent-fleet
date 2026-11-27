// @ts-nocheck
// Pure Node-compatible consumer configuration; no I/O or provider construction.
export const GIT_TRACKED_INCLUDE = 'git:tracked';
export const AGENTIC_LIMITS = Object.freeze({ maxFiles: 20, maxQuestions: 16, maxStateBytes: 8192, maxQuestionsBytes: 16384, maxSourceBytes: 65536, maxRequestBytes: 131072, maxCallsPerSession: 100, timeoutMs: 2000, collectionMs: 1000, maxHandles: 20, maxRetainedBytes: 1048576 });
/** Accepted `consumers.agenticAsk.mode` values. `on` and `off` are canonical; the legacy `advisory` and `recommended` read as `on`. */
export const AGENTIC_MODES = Object.freeze(['off', 'on', 'advisory', 'recommended']);
/** A missing mode or `off` disables Ask System 1; anything else accepted is `on`. */
export function canonicalAgenticMode(mode) { return mode === undefined || mode === 'off' ? 'off' : 'on'; }
export function parseAgenticConfig(value) {
 if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['mode','remoteContextApproved','include','allowToolOutputs','limits'].includes(k))) throw new Error('Invalid agentic section');
 if ((value.mode !== undefined && !AGENTIC_MODES.includes(value.mode)) || (value.remoteContextApproved !== undefined && typeof value.remoteContextApproved !== 'boolean') || (value.allowToolOutputs !== undefined && typeof value.allowToolOutputs !== 'boolean')) throw new Error('Invalid agentic mode or consent');
 const include = value.include ?? [];
 if (!Array.isArray(include) || include.length > AGENTIC_LIMITS.maxFiles || include.some(p => typeof p !== 'string' || !p || p.length > 1024 || (p.startsWith('git:') && p !== GIT_TRACKED_INCLUDE) || /[\\\0*?]/.test(p) || p.startsWith('/') || p.replace(/\/$/,'').split('/').some(s => !s || s === '.' || s === '..'))) throw new Error('Invalid include scope');
 const supplied = value.limits ?? {};
 if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied) || Object.keys(supplied).some(k => !Object.hasOwn(AGENTIC_LIMITS,k))) throw new Error('Invalid agentic limits');
 const limits = { ...AGENTIC_LIMITS, ...supplied };
 if (Object.entries(limits).some(([key,n]) => !Number.isSafeInteger(n) || n <= 0 || n > AGENTIC_LIMITS[key])) throw new Error('Invalid agentic limits');
 const mode = canonicalAgenticMode(value.mode);
 return { mode, ...(mode === 'on' && value.mode !== 'on' ? { legacyMode:value.mode } : {}), remoteContextApproved:value.remoteContextApproved === true, include:[...include], allowToolOutputs:value.allowToolOutputs === true, limits };
}
