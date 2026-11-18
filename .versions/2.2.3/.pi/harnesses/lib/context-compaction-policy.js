/** Operator-approved automatic policy. Explicit user compaction is independent. */
export const COMPACTION_MIN_PERCENT = 50;
export const COMPACTION_EARLY_PERCENT = 60;
export const COMPACTION_TARGET_PERCENT = 70;
export const COMPACTION_MAX_PERCENT = 80;
/** One hysteresis band of new history since the first post-compaction measurement. */
export const COMPACTION_REARM_GROWTH_PERCENT = COMPACTION_TARGET_PERCENT - COMPACTION_EARLY_PERCENT;

/** @param {unknown} value @returns {value is number} */
const count = value => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** A window whose post-compaction baseline stays above the early threshold (system
 * prompt, tool schemas, summary and kept recent turns) can never fall below it, so
 * automatic compaction also re-arms once that much new history could be summarized.
 * @param {number|null|undefined} baselineTokens first measurement after a compaction
 * @param {number|null|undefined} tokens
 * @param {number|null|undefined} contextWindow
 */
export function compactionRearmed(baselineTokens, tokens, contextWindow) {
 if (!count(tokens) || !count(baselineTokens) || !count(contextWindow) || contextWindow === 0) return false;
 return tokens - baselineTokens >= contextWindow * COMPACTION_REARM_GROWTH_PERCENT / 100;
}

/** Compaction left usage between its target and the ceiling: another compaction
 * cannot reach the target before one band of growth, so holding work at the ceiling
 * would only stall it. A baseline at or above the ceiling still stops work, because
 * the window cannot hold the history that compaction keeps.
 * @param {number|null|undefined} baselineTokens
 * @param {number|null|undefined} contextWindow
 */
export function compactionShortOfTarget(baselineTokens, contextWindow) {
 if (!count(baselineTokens) || !count(contextWindow) || contextWindow === 0) return false;
 const percent = baselineTokens / contextWindow * 100;
 return percent >= COMPACTION_TARGET_PERCENT && percent < COMPACTION_MAX_PERCENT;
}
