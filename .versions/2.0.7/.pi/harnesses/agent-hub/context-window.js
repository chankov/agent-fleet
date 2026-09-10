// Context-window resolution and the pre-spawn overflow guard.
//
// The bug this fixes: the hub measured EVERY specialist and research helper
// against `ctx.model.contextWindow` — the DISPATCHER's window. A specialist on
// custom/Qwen3.8-27B-Uncensored-MLX-4bit (49152) and one on a 400k hosted model were
// divided by the same number, so `⚠ Planner context at 315%` could mean either
// "the window is wrong for that provider" or "the run really did run 3× over",
// and nothing in the output told them apart.
//
// The authoritative source is pi's own model registry (ctx.modelRegistry.find),
// which is where the dispatcher's own window came from. This module keeps the
// resolution pure by taking a `lookup(provider, modelId)` function, and records
// WHERE each window came from so a wrong number is traceable rather than
// mysterious.

/** Stop resuming a session when the projected prompt reaches this share of the window. */
export const PRESPAWN_HEADROOM = 0.9;

/**
 * "openrouter/google/gemini-3-flash-preview" → provider "openrouter",
 * model id "google/gemini-3-flash-preview". A spec with no slash has no
 * provider and cannot be looked up.
 */
export function splitModelSpec(spec) {
	const s = String(spec ?? "").trim();
	const slash = s.indexOf("/");
	if (slash <= 0 || slash === s.length - 1) return { provider: "", modelId: s };
	return { provider: s.slice(0, slash), modelId: s.slice(slash + 1) };
}

/**
 * Resolve the context window for a model spec.
 * `lookup(provider, modelId)` is pi's registry find (may return undefined);
 * `fallbackWindow` is the dispatcher's own window, used only when the registry
 * has nothing. Returns { window, source } — source names the origin so a
 * suspicious percentage can be traced to the number that produced it.
 */
export function resolveContextWindow(spec, { lookup, fallbackWindow = 0 } = {}) {
	const { provider, modelId } = splitModelSpec(spec);
	if (provider && typeof lookup === "function") {
		let model;
		try { model = lookup(provider, modelId); } catch { model = undefined; }
		const win = Number(model?.contextWindow);
		if (Number.isFinite(win) && win > 0) {
			return { window: win, source: `pi model registry (${provider}/${modelId})` };
		}
	}
	const fallback = Number(fallbackWindow);
	if (Number.isFinite(fallback) && fallback > 0) {
		return {
			window: fallback,
			// Named explicitly: this is the number that made 315% ambiguous.
			source: `dispatcher's own model — not ${spec || "this model"}'s window`,
		};
	}
	return { window: 0, source: "unknown" };
}

/** Percent of the window consumed. 0 when the window is unknown. */
export function contextPct({ input = 0, cacheRead = 0, cacheWrite = 0 } = {}, window) {
	const win = Number(window);
	if (!Number.isFinite(win) || win <= 0) return 0;
	return (((input || 0) + (cacheRead || 0) + (cacheWrite || 0)) / win) * 100;
}

/**
 * Rough prompt size in tokens. Deliberately crude (~4 chars/token) — it decides
 * whether to start a session fresh, and being approximately right before the
 * run beats being exactly right after it.
 */
export function estimatePromptTokens(text) {
	return Math.ceil(String(text ?? "").length / 4);
}

/**
 * Pre-spawn guard: would resuming this session overflow the window? Recycling
 * AFTER the run is what made the post-mortem's warnings arrive 985s too late.
 * `priorTokens` is the resumed session's last measured total.
 */
export function shouldRecycleBeforeSpawn({ priorTokens = 0, promptTokens = 0, window, headroom = PRESPAWN_HEADROOM }) {
	const win = Number(window);
	if (!Number.isFinite(win) || win <= 0) return null;
	if (priorTokens <= 0) return null; // nothing accumulated — nothing to drop
	const projected = priorTokens + promptTokens;
	const limit = win * headroom;
	if (projected < limit) return null;
	return {
		projected,
		window: win,
		message:
			`projected prompt ~${Math.round(projected / 1000)}k tokens against a ${Math.round(win / 1000)}k window ` +
			`(${Math.round((projected / win) * 100)}%)`,
	};
}

/**
 * The one-time diagnostic for a reading over 100%: name the window and where it
 * came from, so "wrong window" and "genuine overflow" stop looking identical.
 */
export function overWindowDiagnostic({ agent, model, pct, window, source }) {
	return (
		`⚠ ${agent} measured ${Math.round(pct)}% of its context window (${Math.round(window / 1000)}k tokens, ` +
		`source: ${source}) on ${model}. Over 100% means either that window is wrong for this provider or the ` +
		"run genuinely exceeded it — compare the model's declared window before treating the number as real."
	);
}
