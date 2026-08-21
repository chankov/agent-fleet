// Per-provider in-flight semaphore.
//
// A dispatch may fan out to four delegate children at once, concurrent children
// are explicitly allowed, and several specialists can be mid-run — with nothing
// bounding how many requests land on ONE provider. That is survivable against a
// hosted endpoint and not against a local one: `custom/*` is a single machine,
// and the observed symptom was mid-run OOM on exactly the children that exist to
// protect the parent's context.
//
// Scope, stated plainly: this bounds the direct children spawned by ONE process.
// A nested delegate runs in its own pi process with its own semaphore, so the
// cap is per level of the tree, not global across the fleet. That is deliberate
// — a cross-process lock would have to survive crashed holders, and the level
// cap already removes the burst that caused the failures. Within one process the
// leaf holds the permit and a parent hands its own permit down (`parent`), so a
// nested spawn can never wait on its ancestor.

/** Only the local endpoint is capped by default; hosted providers scale on their side. */
export const DEFAULT_PROVIDER_LIMITS = Object.freeze({ custom: 2 });

/** "custom/Qwen3.8-27B-Uncensored-MLX-4bit" → "custom"; the part before the first slash. */
export function providerKey(model) {
	const spec = String(model ?? "").trim().toLowerCase();
	const slash = spec.indexOf("/");
	return slash < 0 ? spec : spec.slice(0, slash);
}

/** Concurrency cap for a model spec, or null when the provider is unlimited. */
export function providerLimit(model, limits = DEFAULT_PROVIDER_LIMITS) {
	const limit = (limits || {})[providerKey(model)];
	return Number.isFinite(limit) && limit > 0 ? limit : null;
}

/**
 * Parse an override list: "custom=3,ollama=1". A value of 0 or "off" means
 * unlimited (recorded as null so it overrides a default cap). Junk is dropped —
 * a malformed env var must never make the hub refuse to start.
 */
export function parseProviderLimits(raw) {
	const out = {};
	for (const part of String(raw ?? "").split(",")) {
		const [rawKey, rawValue] = part.split("=");
		if (rawValue === undefined) continue;
		const key = String(rawKey).trim().toLowerCase();
		const value = String(rawValue).trim().toLowerCase();
		if (!key) continue;
		if (value === "off" || value === "none" || value === "unlimited") { out[key] = null; continue; }
		const n = Number(value);
		if (!Number.isFinite(n)) continue;
		out[key] = n > 0 ? Math.floor(n) : null;
	}
	return out;
}

/**
 * FIFO semaphore keyed by provider prefix.
 *
 * - `acquire(model)` → Promise<release>. `release()` is idempotent.
 * - `run(model, fn, { parent })` → runs `fn(permit)` under a permit and releases
 *   it however `fn` settles. Pass the permit you were given as `parent` when
 *   spawning on the same provider from inside `fn`: the call reuses it instead
 *   of taking a second one.
 *
 * Admission is synchronous when a permit is free, and a release hands off
 * directly to the head of the queue, so ordering is exactly request order.
 */
export function createProviderSemaphore(limits = DEFAULT_PROVIDER_LIMITS) {
	/** @type {Map<string, { live: number, queue: Array<(release: () => void) => void> }>} */
	const lanes = new Map();

	const lane = (key) => {
		let l = lanes.get(key);
		if (!l) { l = { live: 0, queue: [] }; lanes.set(key, l); }
		return l;
	};

	const makeRelease = (key) => {
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			const l = lane(key);
			const next = l.queue.shift();
			// Hand the permit straight to the next waiter: `live` never dips, so a
			// third caller arriving in between cannot jump the queue.
			if (next) next(makeRelease(key));
			else l.live--;
		};
		release.provider = key;
		return release;
	};

	/** A free permit now, or null when the lane is full. */
	const tryAcquire = (key, limit) => {
		const l = lane(key);
		if (limit != null && l.live >= limit) return null;
		l.live++;
		return makeRelease(key);
	};

	function acquire(model) {
		const key = providerKey(model);
		const limit = providerLimit(model, limits);
		const permit = tryAcquire(key, limit);
		if (permit) return Promise.resolve(permit);
		return new Promise((resolve) => lane(key).queue.push(resolve));
	}

	function run(model, fn, { parent } = {}) {
		const key = providerKey(model);
		// Reentrancy: a parent holding this provider's permit lends it to its own
		// nested spawn rather than queueing behind itself.
		if (typeof parent === "function" && parent.provider === key) {
			try { return Promise.resolve(fn(parent)); } catch (error) { return Promise.reject(error); }
		}
		const invoke = (permit) => {
			let result;
			try { result = fn(permit); } catch (error) { permit(); return Promise.reject(error); }
			return Promise.resolve(result).then(
				(value) => { permit(); return value; },
				(error) => { permit(); throw error; },
			);
		};
		const permit = tryAcquire(key, providerLimit(model, limits));
		if (permit) return invoke(permit);
		return new Promise((resolve, reject) => {
			lane(key).queue.push((granted) => invoke(granted).then(resolve, reject));
		});
	}

	return {
		acquire,
		run,
		inFlight: (model) => lane(providerKey(model)).live,
		queued: (model) => lane(providerKey(model)).queue.length,
		limitFor: (model) => providerLimit(model, limits),
	};
}
