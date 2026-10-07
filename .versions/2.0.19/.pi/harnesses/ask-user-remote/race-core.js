// Pure race arbitration for the ask-user-remote harness.
//
// The wrapper supplies the side-effecting pieces:
// - runLocal(signal): stock pi-ask-user execute with an AbortSignal
// - startRemote(): starts a user-remote coms request and returns
//   { qid, result: Promise<stock-shaped ask_user result> }, or null when no peer
// - cancelRemote(qid, reason): best-effort cancel envelope for local-first wins
//
// This module owns only the first-answer-wins latch and exactly-once cancel/
// abort decisions; it has no pi, socket, or filesystem imports.

export async function raceAskUser({
	runLocal,
	startRemote,
	cancelRemote,
	createAbortController = () => new AbortController(),
	signal,
	registerAnswer,
	onSettled,
}) {
	if (typeof runLocal !== "function") throw new TypeError("runLocal is required");

	const controller = createAbortController();
	let settled = false;
	let remotePending = false;
	let remoteQid = null;
	let cancelSent = false;

	async function emitCancel(reason) {
		if (cancelSent || !remotePending || !remoteQid || typeof cancelRemote !== "function") return;
		cancelSent = true;
		try {
			await cancelRemote(remoteQid, reason);
		} catch {
			// Cancel is best-effort; the winning local answer must not fail because
			// the losing remote channel is already unhealthy.
		}
	}

	const localPromise = Promise.resolve().then(() => runLocal(controller.signal));

	let remoteStart = null;
	if (typeof startRemote === "function") {
		try {
			remoteStart = await Promise.resolve().then(() => startRemote());
		} catch {
			remoteStart = null;
		}
	}

	// No live user-remote peer, or remote startup failed before a qid existed:
	// preserve stock pi-ask-user behavior exactly by returning the local result.
	if (!remoteStart && !registerAnswer) return await localPromise;

	remoteQid = typeof remoteStart?.qid === "string" ? remoteStart.qid : null;
	remotePending = !!remoteQid;
	const remotePromise = remoteStart ? Promise.resolve(remoteStart.result) : null;

	// If the whole tool call is aborted (turn cancelled), withdraw the remote
	// question instead of leaving it live on the phone until timeout.
	if (signal) {
		if (signal.aborted) void emitCancel("aborted");
		else signal.addEventListener("abort", () => { void emitCancel("aborted"); }, { once: true });
	}

	return await new Promise((resolve, reject) => {
		const finish = (source, result) => { onSettled?.({ source, result }); };
		// The addressed endpoint receives the result of this same synchronous latch.
		// A successful submission cannot lose to a later local or legacy reply.
		registerAnswer?.((result) => {
			if (settled || signal?.aborted) return false;
			settled = true;
			finish("addressed", result);
			controller.abort?.();
			void emitCancel("addressed_answered");
			resolve(result);
			return true;
		});
		let localRejected = false;
		let localError;
		let remoteRejected = !remotePromise;

		localPromise.then(
			async (result) => {
				if (settled) return;
				settled = true;
				finish("local", result);
				await emitCancel("local_answered");
				resolve(result);
			},
			(error) => {
				if (settled) return;
				localRejected = true;
				localError = error;
				if (remoteRejected) {
					settled = true;
					finish("error", undefined);
					reject(localError);
				}
			},
		);

		remotePromise?.then(
			(result) => {
				remotePending = false;
				if (settled) return;
				settled = true;
				finish("remote", result);
				controller.abort?.();
				resolve(result);
			},
			() => {
				remotePending = false;
				remoteRejected = true;
				// Remote errors are non-fatal: keep waiting for stock local behavior.
				if (localRejected) {
					settled = true;
					finish("error", undefined);
					reject(localError);
				}
			},
		);
	});
}
