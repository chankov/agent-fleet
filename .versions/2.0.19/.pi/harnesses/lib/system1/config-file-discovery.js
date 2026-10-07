// Pure independent consumer configuration. Defaults are also supported maxima.
export const FILE_DISCOVERY_LIMITS = Object.freeze({
 concurrency: 8, maxQueuedJobs: 32, maxCandidates: 1024,
 maxEvaluationsPerJob: 256, maxCallsPerSession: 10000, maxFileBytes: 65536,
 maxRequestBytes: 131072, maxSourceBytesPerJob: 16777216, discoveryMs: 1000,
 jobTimeoutMs: 20000, resultPageBytes: 32768, maxCacheEntries: 2048,
});
/** @param {unknown} value */
export function parseFileDiscoveryConfig(value) {
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid fileDiscovery section');
 const section = /** @type {Record<string, any>} */ (value);
 if (Object.keys(section).some(k => !['mode','remoteContextApproved','include','limits'].includes(k)) || !['off','active'].includes(section.mode) || (section.remoteContextApproved !== undefined && typeof section.remoteContextApproved !== 'boolean')) throw Error('Invalid fileDiscovery section');
 const include = section.include ?? [];
 if (!Array.isArray(include) || include.length > 20 || include.some(p => typeof p !== 'string' || !p || p.length > 1024 || /[\\\0*?]/.test(p) || p.startsWith('/') || p.replace(/\/$/,'').split('/').some(s => !s || s === '.' || s === '..'))) throw Error('Invalid include scope');
 if (section.mode === 'active' && section.remoteContextApproved === true && !include.length) throw Error('Explicit include scope required');
 const supplied = section.limits ?? {};
 if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied) || Object.keys(supplied).some(k => !Object.hasOwn(FILE_DISCOVERY_LIMITS,k))) throw Error('Invalid fileDiscovery limits');
 const limits = { ...FILE_DISCOVERY_LIMITS, ...supplied };
 if (Object.entries(limits).some(([k,n]) => !Number.isSafeInteger(n) || n <= 0 || n > FILE_DISCOVERY_LIMITS[/** @type {keyof typeof FILE_DISCOVERY_LIMITS} */ (k)])) throw Error('Invalid fileDiscovery limits');
 return { mode: /** @type {'off'|'active'} */ (section.mode), remoteContextApproved: section.remoteContextApproved === true, include: /** @type {string[]} */ ([...include]), limits: /** @type {Record<keyof typeof FILE_DISCOVERY_LIMITS, number>} */ (limits) };
}
