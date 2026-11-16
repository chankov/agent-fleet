export interface EvidenceManifestInput {
	revision: string;
	scope: string[];
	changes: string[];
	commands: { command: string; exitCode: number }[];
	tests: { executed: number; passed: number; failed: number; testIds?: string[] };
	evidenceRefs: string[];
	openAssertions: string[];
	observedRevision: string;
	maxChanges?: number;
	fullArtifact?: string;
}

export interface EvidenceManifest {
	revision: string;
	scope: string[];
	changes: string[];
	commands: { command: string; exitCode: number }[];
	tests: EvidenceManifestInput["tests"];
	evidenceRefs: string[];
	openAssertions: string[];
	truncated: boolean;
	fullArtifact?: string;
	stale: boolean;
	mismatch: boolean;
}

export function buildEvidenceManifest(input: EvidenceManifestInput): EvidenceManifest {
	const limit = input.maxChanges ?? input.changes.length;
	const truncated = input.changes.length > limit;
	const outsideScope = input.changes.some(path => !input.scope.includes(path));
	return {
		revision: input.revision,
		scope: [...input.scope],
		changes: input.changes.slice(0, limit),
		commands: input.commands.map(command => ({ ...command })),
		tests: { ...input.tests, testIds: input.tests.testIds ? [...input.tests.testIds] : undefined },
		evidenceRefs: [...input.evidenceRefs],
		openAssertions: [...input.openAssertions],
		truncated,
		...(truncated ? { fullArtifact: input.fullArtifact } : {}),
		stale: input.observedRevision !== input.revision,
		mismatch: outsideScope,
	};
}

export function rawReadsRequired(manifest: EvidenceManifest, requested: string[]): string[] {
	if (manifest.stale || manifest.mismatch || manifest.truncated) return [...requested];
	const covered = new Set([...manifest.scope, ...manifest.changes, ...manifest.evidenceRefs]);
	return requested.filter(path => !covered.has(path));
}
