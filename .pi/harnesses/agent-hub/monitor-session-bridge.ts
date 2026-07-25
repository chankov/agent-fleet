import { MonitorStore } from "../lib/hermes-monitor-store.ts";
import { MonitorPublisher } from "./monitor-publisher.ts";

const terminal = (state: any) => ["completed", "blocked", "failed", "cancelled", "orphaned", "done"].includes(state);

/**
 * Translates Hub lifecycle mutations into durable monitor facts. Publication failures
 * are isolated from Hub work: task state remains authoritative in MonitorStore.
 */
export function createMonitorSessionBridge(deps: any = {}) {
	const store = deps.store ?? new MonitorStore({ now: deps.now });
	const pub = deps.publisher ?? new MonitorPublisher(store);
	const keys = new Map<string, { id: string; generation: number }>();
	const ready = new Map<string, Promise<any>>();
	const late = new Map<string, any[]>();
	const finalized = new Map<string, Promise<any>>();
	const cancellable = new Set<string>();
	const waitAborts = new Map<string, () => unknown>();
	const recovering = new Map<string, string>();
	const monitorKeyByTask = new Map<string, string>();
	const lateByGeneration = new Map<string, any[]>();
	let eventSequence = deps.events?.latestSequence?.() ?? 0;
	let currentOwner: any = deps.currentOwner ?? {};
	let eventIdentity: { profileKey?: string; hubInstanceId?: string } = {
		profileKey: deps.profileKey,
		hubInstanceId: deps.hubInstanceId,
	};
	const runtime = deps.runtime;

	const records = () => store.snapshot().tasks as any[];
	const taskKey = (task: any) => `${task.id}:${task.generation}`;
	const eventTask = (task: any, fromState?: string) => ({
		id: task.id,
		generation: task.generation,
		parentId: task.parentId,
		specialist: task.specialist,
		...(fromState ? { fromState } : {}),
		toState: task.state,
		outputSequence: task.outputSequence ?? 0,
	});
	const publishEvent = (kind: string, task?: any, extra: any = {}) => {
		if (!deps.events) return undefined;
		const profileKey = eventIdentity.profileKey;
		const hubInstanceId = task?.hubInstanceId ?? eventIdentity.hubInstanceId;
		const ownerId = currentOwner.ownerSessionId;
		if (!profileKey || !hubInstanceId || !ownerId) {
			deps.onEventJournalError?.(new Error("monitor event identity is unavailable"));
			return undefined;
		}
		const next = eventSequence + 1;
		const event = {
			schema: "agent-fleet.monitor-event",
			schemaVersion: 1,
			eventId: `${hubInstanceId}:${next}`,
			eventSequence: next,
			profileKey,
			hubInstanceId,
			ownerId,
			occurredAt: (deps.now?.() ?? new Date()).toISOString(),
			kind,
			...(task ? { task: eventTask(task, extra.fromState) } : {}),
			materialKey: task ? `${kind}:${task.id}:${task.generation}:${task.state}` : `${kind}:${ownerId}`,
			...extra,
		};
		try {
			deps.events.append(event);
			eventSequence = next;
			return event;
		} catch (error) {
			deps.onEventJournalError?.(error);
			return undefined;
		}
	};
	const transition = (id: string, generation: number, state: any) => {
		const before = store.get(id, generation)?.state;
		const task = pub.transition(id, generation, state);
		publishEvent("task.state_changed", task, { fromState: before });
		return task;
	};

	try {
		if (runtime) {
			for (const task of runtime.load().tasks ?? []) {
				store.restore([task]);
				if (!task.monitorKey) continue;
				const id = taskKey(task);
				monitorKeyByTask.set(id, task.monitorKey);
				if (task.lateHistory) lateByGeneration.set(`${task.monitorKey}:${task.generation}`, task.lateHistory);
				const prior = keys.get(task.monitorKey);
				if (!prior || prior.generation < task.generation) {
					keys.set(task.monitorKey, { id: task.id, generation: task.generation });
					ready.set(task.monitorKey, Promise.resolve(task));
				}
			}
		}
	} catch (error) {
		throw error;
	}

	const persist = () => runtime?.save({
		tasks: (store.durableSnapshot?.().tasks ?? records()).map((task: any) => ({
			...task,
			monitorKey: monitorKeyByTask.get(taskKey(task)),
			lateHistory: lateByGeneration.get(`${monitorKeyByTask.get(taskKey(task))}:${task.generation}`) ?? [],
		})),
	});
	const lateEvent = (key: string, event: any, generation?: number) => {
		generation ??= keys.get(key)?.generation;
		const lateKey = generation === undefined ? key : `${key}:${generation}`;
		const history = lateByGeneration.get(lateKey) ?? [];
		history.push(event);
		if (history.length > 200) history.splice(0, history.length - 200);
		lateByGeneration.set(lateKey, history);
		late.set(key, history);
		const task = generation === undefined ? undefined : store.get(keys.get(key)?.id ?? "", generation);
		if (task) publishEvent("task.late_event", task);
		persist();
		return { state: "cancelled", history };
	};
	const after = (key: string, work: (value: any) => any) => {
		const pending = ready.get(key);
		if (!pending) return Promise.reject(new Error(`child ${key} is not registered`));
		const chained = pending.then(() => work(keys.get(key))).then(value => { persist(); return value; });
		ready.set(key, chained.catch(() => undefined));
		return chained;
	};
	const output = (task: any, text: string) => {
		const result = pub.publishPublicOutput(task.id, task.generation, text);
		publishEvent("task.output_advanced", store.get(task.id, task.generation));
		return result;
	};

	return {
		setEventIdentity(identity: { profileKey: string; hubInstanceId: string }) { eventIdentity = { ...identity }; },
		setCurrentOwner(owner: any) {
			const changed = currentOwner.ownerSessionId !== owner.ownerSessionId || currentOwner.ownerLeaseExpiresAt !== owner.ownerLeaseExpiresAt;
			currentOwner = { ...owner };
			if (changed && owner.ownerSessionId && owner.ownerLeaseExpiresAt) publishEvent("owner.lease_changed", undefined, { ownerLeaseExpiresAt: owner.ownerLeaseExpiresAt });
			if (owner.updateActive) for (const task of records()) if (!terminal(task.state)) {
				if (!task.ownerSessionId || task.ownerSessionId === owner.ownerSessionId) store.patch(task.id, task.generation, {
					ownerSessionId: owner.ownerSessionId,
					ownerLeaseExpiresAt: owner.ownerLeaseExpiresAt,
				});
			}
			persist();
		},
		publishEvent(kind: string, task: any, extra?: any) { return publishEvent(kind, task, extra); },
		publishHubEvent(kind: string, extra?: any) { return publishEvent(kind, undefined, extra); },
		startParent(value: any) {
			const task = pub.publishParent({ ...value, ...currentOwner, generation: value.generation ?? 1 });
			keys.set(`parent:${task.id}`, { id: task.id, generation: task.generation });
			monitorKeyByTask.set(taskKey(task), `parent:${task.id}`);
			publishEvent("hub.turn_started", task);
			persist();
			return task;
		},
		finishParent(id: string, state: any = "completed") {
			const value = keys.get(`parent:${id}`);
			if (!value) return undefined;
			const task = store.get(value.id, value.generation);
			if (!task || terminal(task.state)) return task;
			const done = transition(value.id, value.generation, state);
			publishEvent("hub.turn_completed", done);
			persist();
			return done;
		},
		startChild(value: any, env: any) {
			const existing = ready.get(value.key);
			if (existing) {
				const prior = keys.get(value.key);
				const task = prior && store.get(prior.id, prior.generation);
				if (!task || !terminal(task.state)) return existing;
				publishEvent("task.generation_superseded", task);
				value = { ...value, generation: prior.generation + 1 };
				ready.delete(value.key);
			}
			const pending = Promise.resolve().then(() => pub.publishChildForHub({ ...value, ...currentOwner, parentGeneration: value.parentGeneration ?? 1 }, env)).then((task: any) => {
				keys.set(value.key, { id: task.id, generation: task.generation });
				monitorKeyByTask.set(taskKey(task), value.key);
				publishEvent("task.started", task);
				persist();
				return { ...task, monitorKey: value.key };
			});
			ready.set(value.key, pending);
			pending.catch(() => ready.delete(value.key));
			return pending;
		},
		appendOutputFor(value: any, text: string) {
			const task = store.get(value.id, value.generation);
			if (!task || terminal(task.state)) return lateEvent(monitorKeyByTask.get(taskKey(value)) ?? value.monitorKey, { kind: "late_output", text }, value.generation);
			const result = output(task, text); persist(); return result;
		},
		finalizeChildFor(value: any, text: string, state: any) {
			const id = taskKey(value); const prior = finalized.get(id); if (prior) return prior;
			const task = store.get(value.id, value.generation); const key = monitorKeyByTask.get(id) ?? value.monitorKey;
			if (!task || terminal(task.state)) return lateEvent(key, { kind: "late_final", text, state }, value.generation);
			const result = Promise.resolve().then(() => { if (text) output(task, text); return transition(value.id, value.generation, state); }).then(done => { persist(); return done; });
			finalized.set(id, result); return result;
		},
		registerOwnedProcessFor(value: any, process: unknown) { const key = value.monitorKey ?? monitorKeyByTask.get(taskKey(value)); cancellable.add(key); return deps.registerOwnedProcess?.(key, process, value); },
		cancelFor(value: any) { return this.cancelTask({ taskId: value.id, generation: value.generation }); },
		registerOwnedProcess(key: string, process: unknown) { return after(key, (value: any) => { cancellable.add(key); return deps.registerOwnedProcess?.(key, process, value); }); },
		registerWaitOnly(key: string, abort?: () => unknown) { return after(key, () => { cancellable.add(key); if (abort) waitAborts.set(key, abort); }); },
		appendOutput(key: string, text: string) { return after(key, (value: any) => { const task = store.get(value.id, value.generation); return terminal(task?.state) ? lateEvent(key, { kind: "late_output", text }) : output(task, text); }); },
		finishChild(key: string, state: any) { return after(key, (value: any) => { const task = store.get(value.id, value.generation); if (terminal(task?.state)) return task?.state === "cancelled" || task?.state === "orphaned" ? lateEvent(key, { kind: "late_finish", state }) : task; return transition(value.id, value.generation, state); }); },
		finalizeChild(key: string, text: string, state: any) { const prior = finalized.get(key); if (prior) return prior; const result = after(key, (value: any) => { const task = store.get(value.id, value.generation); if (terminal(task?.state)) return task?.state === "cancelled" || task?.state === "orphaned" ? lateEvent(key, { kind: "late_final", text, state }) : task; if (text) output(task, text); return transition(value.id, value.generation, state); }); finalized.set(key, result); return result; },
		recordComsFinal(key: string, text: string) { return this.appendOutput(key, text); },
		markCancelling(key: string) { return after(key, (value: any) => terminal(store.get(value.id, value.generation)?.state) ? store.get(value.id, value.generation) : transition(value.id, value.generation, "cancelling")); },
		markCancelled(key: string) { return after(key, (value: any) => store.get(value.id, value.generation)?.state === "cancelled" ? store.get(value.id, value.generation) : transition(value.id, value.generation, "cancelled")); },
		async cancelOwnedProcess(key: string) { return after(key, async (value: any) => { const task = store.get(value.id, value.generation); if (task?.state === "cancelled") return { cancelled: true, state: "cancelled" }; if (!terminal(task?.state)) transition(value.id, value.generation, "cancelling"); const result = await deps.cancelOwnedProcess?.({ taskId: value.id, generation: value.generation }); if (result?.cancelled && !terminal(store.get(value.id, value.generation)?.state)) transition(value.id, value.generation, "cancelled"); if (result?.cancelled) cancellable.delete(key); return result ?? { cancelled: false, reason: "unsupported" }; }); },
		cancelAllWaitOnly() { return Promise.all([...waitAborts.keys()].map(key => this.cancelWaitOnly(key, { kind: "session_reset" }))); },
		cancelWaitOnly(key: string, event: unknown) { return after(key, async (value: any) => { await waitAborts.get(key)?.(); const task = store.get(value.id, value.generation); if (!terminal(task?.state)) transition(value.id, value.generation, "cancelled"); cancellable.delete(key); waitAborts.delete(key); return lateEvent(key, event); }); },
		cancelTask(request: any) { const entry = [...keys.entries()].find(([, value]) => value.id === request.taskId && value.generation === request.generation); if (!entry) return Promise.resolve({ cancelled: false, reason: "unsupported" }); const [key] = entry; return waitAborts.has(key) ? this.cancelWaitOnly(key, { kind: "operator_cancel" }).then(() => ({ cancelled: true, state: "cancelled" })) : this.cancelOwnedProcess(key); },
		recordComsLateEvent(key: string, event: unknown) { return lateEvent(key, event); },
		readOutput(request: any) { return store.readOutput(request.taskId, request.generation, request.afterSequence); },
		prune() { const value = store.prune(); persist(); return value; },
		reconcile(e: any) {
			for (const task of records()) {
				// Grouped explicitly: a task-scoped probe skips other tasks, and a
				// terminal task is never reconciled regardless of the filter.
				const filteredOut = Boolean(e?.taskId) && taskKey(task) !== e.taskId;
				if (filteredOut || terminal(task.state)) continue;

				const old = task.ownerSessionId && task.ownerSessionId !== currentOwner.ownerSessionId;
				const leaseExpiresAt = Date.parse(task.ownerLeaseExpiresAt ?? "");
				const expired = !Number.isFinite(leaseExpiresAt) || (deps.now?.().getTime?.() ?? Date.now()) >= leaseExpiresAt;
				// Evidence for the previous owner's registration versus the current one.
				const oldEvidenceGone = e?.oldOwner === false && e?.oldSocket === false && e?.oldSession === false && e?.oldHerdr === false;
				const currentEvidenceGone = !e?.owner && !e?.socket && !e?.session && !e?.herdr;
				const currentEvidencePresent = Boolean(e?.owner && e?.socket && e?.session && e?.herdr);

				const orphaned = !e?.transient && ((old && expired && oldEvidenceGone) || (!old && expired && currentEvidenceGone));
				if (orphaned) {
					const done = transition(task.id, task.generation, "orphaned");
					publishEvent("owner.orphaned", done);
					continue;
				}

				const lostContact = old || e?.transient || currentEvidenceGone;
				if (lostContact && task.state !== "recovering") {
					recovering.set(taskKey(task), task.state);
					const next = transition(task.id, task.generation, "recovering");
					publishEvent("owner.recovering", next);
					continue;
				}

				if (task.state === "recovering" && currentEvidencePresent) {
					transition(task.id, task.generation, recovering.get(taskKey(task)) ?? "running");
				}
			}
			persist(); return this.snapshot();
		},
		snapshot() { persist(); return { tasks: records().map((task: any) => { const key = monitorKeyByTask.get(taskKey(task)); return { id: task.id, generation: task.generation, kind: task.kind, parentId: task.parentId, parentGeneration: task.parentGeneration, specialist: task.specialist, state: task.state, workspaceId: task.workspaceId, hubPaneId: task.hubPaneId, hubInstanceId: task.hubInstanceId, ownerSessionId: task.ownerSessionId, ownerLeaseExpiresAt: task.ownerLeaseExpiresAt, outputSequence: task.outputSequence, firstSequence: task.firstSequence, truncated: task.truncated, canCancel: !!key && cancellable.has(key) && !terminal(task.state) }; }) }; },
		reset() { keys.clear(); ready.clear(); late.clear(); finalized.clear(); cancellable.clear(); monitorKeyByTask.clear(); lateByGeneration.clear(); persist(); },
		stop() { keys.clear(); ready.clear(); late.clear(); finalized.clear(); cancellable.clear(); monitorKeyByTask.clear(); lateByGeneration.clear(); },
	};
}
