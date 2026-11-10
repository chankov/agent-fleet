export interface PanelResources {
	every(ms: number, fn: () => void): void;
	onDispose(fn: () => void): void;
	dispose(): void;
	readonly closed: boolean;
}

/** Own timers and cleanup callbacks for one disposable overlay component. */
export function createPanelResources(): PanelResources {
	let closed = false;
	const teardowns: Array<() => void> = [];
	return {
		every(ms, fn) {
			if (closed) return;
			const timer = setInterval(fn, ms);
			teardowns.push(() => clearInterval(timer));
		},
		onDispose(fn) {
			if (closed) {
				fn();
				return;
			}
			teardowns.push(fn);
		},
		dispose() {
			if (closed) return;
			closed = true;
			for (const teardown of teardowns.splice(0)) {
				try { teardown(); } catch {}
			}
		},
		get closed() { return closed; },
	};
}
