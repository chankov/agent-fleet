import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { safePathWithin } from "../helpers.ts";
import { artifactPreviewFromText, formatInputArtifactsSection, resolveArtifactPaths, ARTIFACT_KINDS } from "../artifacts.js";
import { appendRunIndex, buildRunMeta, makeRunId, pruneRunDirs, RUN_INDEX_FILENAME, RUNS_DIRNAME } from "../run-namespace.js";

export type AssertionStatus = "open" | "proven" | "unproven" | "failed";

export interface Assertion {
	id: string;
	tag: string;
	text: string;
	source: string;
	status: AssertionStatus;
	evidence?: string;
}

export interface InputArtifactPreview {
	input: string;
	path: string;
	displayPath: string;
	preview: string;
	resolvedFromKind?: string | null;
}

export interface AssertionsArtifactsStatePorts {
	getAssertions(): Assertion[];
	getSessionDir(): string;
	getRunHistoryKeep(): number | null;
	setStatus(key: string, value: string): void;
}

export interface AssertionsArtifactsContext {
	persistAssertions(): void;
	assertionStatusLine(): string;
	renderAssertionLedgerLines(): string[];
	renderAssertionLedgerText(): string;
	updateAssertionStatus(): void;
	artifactsRoot(): string;
	ensureArtifactsLayout(): string;
	archivePreviousRun(): string | null;
	loadInputArtifacts(paths: string[] | undefined, ctx: { cwd?: string }): InputArtifactPreview[];
	appendInputArtifacts(task: string, artifacts: InputArtifactPreview[]): string;
	writeRunArtifact(agentKey: string, runCount: number, output: string, kind?: "returns" | "failures"): string;
	evidencePathExists(evidencePath: string): boolean;
	listArtifactFiles(): string[];
	renderArtifactIndexText(): string;
	appendMachineHandoffSections(brief: string): string;
}

export function createAssertionsArtifactsContext(state: AssertionsArtifactsStatePorts): AssertionsArtifactsContext {
	const artifactsRoot = () => safePathWithin(state.getSessionDir(), "artifacts");
	const ensureArtifactsLayout = () => {
		const root = artifactsRoot();
		mkdirSync(root, { recursive: true });
		for (const kind of ARTIFACT_KINDS) mkdirSync(safePathWithin(root, kind), { recursive: true });
		return root;
	};
	const assertionStatusLine = () => {
		const assertions = state.getAssertions();
		if (assertions.length === 0) return "";
		const count = (status: AssertionStatus) => assertions.filter(assertion => assertion.status === status).length;
		const open = assertions.filter(assertion => assertion.status === "open" || assertion.status === "unproven").map(assertion => assertion.id);
		const failed = assertions.filter(assertion => assertion.status === "failed").map(assertion => assertion.id);
		const head = `Assertions: ${count("proven")}✓ ${open.length}○ ${count("failed")}✗`;
		if (failed.length) return `${head} · failed: ${failed.join(",")}`;
		if (open.length) return `${head} · open: ${open.join(",")}`;
		return `${head} · all proven`;
	};
	const renderAssertionLedgerLines = () => state.getAssertions().map(assertion => {
		const evidence = assertion.evidence ? ` — evidence: ${assertion.evidence}` : "";
		const source = assertion.source ? ` ⇐ ${assertion.source}` : "";
		return `${assertion.id} [${assertion.tag}] ${assertion.status.toUpperCase()}: ${assertion.text}${source}${evidence}`;
	});
	const renderAssertionLedgerText = () => state.getAssertions().length === 0
		? ""
		: `${assertionStatusLine()}\n${renderAssertionLedgerLines().join("\n")}`;
	const listArtifactFiles = () => {
		const root = artifactsRoot();
		if (!existsSync(root)) return [];
		const out: string[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (entry.isFile()) out.push(full);
			}
		};
		try { walk(root); } catch { return []; }
		return out.sort();
	};
	const renderArtifactIndexText = () => {
		const root = artifactsRoot();
		return listArtifactFiles().map(file => {
			const relative = path.relative(root, file).split(path.sep).join("/");
			let preview = "(unreadable)";
			try { preview = artifactPreviewFromText(readFileSync(file, "utf-8")); } catch {}
			return `artifacts/${relative} — ${preview}`;
		}).join("\n");
	};

	return {
		persistAssertions() {
			if (!state.getSessionDir()) return;
			try { writeFileSync(safePathWithin(state.getSessionDir(), "assertions.json"), JSON.stringify(state.getAssertions(), null, 2)); } catch {}
		},
		assertionStatusLine,
		renderAssertionLedgerLines,
		renderAssertionLedgerText,
		updateAssertionStatus() {
			const line = assertionStatusLine();
			if (!line) return;
			try { state.setStatus("assertions", line); } catch {}
		},
		artifactsRoot,
		ensureArtifactsLayout,
		archivePreviousRun() {
			const root = artifactsRoot();
			if (!existsSync(root)) return null;
			const counts: Record<string, number> = {};
			let total = 0;
			try {
				for (const kind of ARTIFACT_KINDS) {
					const dir = safePathWithin(root, kind);
					if (!existsSync(dir)) continue;
					const count = readdirSync(dir).length;
					if (count > 0) counts[kind] = count;
					total += count;
				}
			} catch {}
			if (total === 0) {
				try { rmSync(root, { recursive: true, force: true }); } catch {}
				return null;
			}
			const runId = makeRunId();
			try {
				const sessionDir = state.getSessionDir();
				const runsDir = safePathWithin(sessionDir, RUNS_DIRNAME);
				const runDir = safePathWithin(runsDir, runId);
				mkdirSync(runDir, { recursive: true });
				renameSync(root, safePathWithin(runDir, "artifacts"));
				const meta = buildRunMeta({
					runId, archivedAt: Date.now(), cwd: sessionDir,
					project: process.env.PI_COMS_PROJECT || null,
					workspace: process.env.HERDR_WORKSPACE_ID || null,
					artifactCounts: counts,
				});
				const metaPath = safePathWithin(runDir, "meta.json");
				writeFileSync(metaPath, JSON.stringify(meta, null, 2));
				try { chmodSync(metaPath, 0o444); } catch {}
				const indexPath = safePathWithin(runsDir, RUN_INDEX_FILENAME);
				let existing: unknown = null;
				try { existing = JSON.parse(readFileSync(indexPath, "utf-8")); } catch {}
				const index = appendRunIndex(existing, {
					runId, archivedAt: meta.archivedAt, artifactCounts: counts,
					project: meta.project, workspace: meta.workspace,
				}, state.getRunHistoryKeep());
				writeFileSync(indexPath, JSON.stringify(index, null, 2));
				for (const stale of pruneRunDirs(readdirSync(runsDir), state.getRunHistoryKeep())) {
					try { rmSync(safePathWithin(runsDir, stale), { recursive: true, force: true }); } catch {}
				}
				return runId;
			} catch {
				return null;
			}
		},
		loadInputArtifacts(paths, ctx) {
			if (!paths?.length) return [];
			const root = ensureArtifactsLayout();
			return resolveArtifactPaths(paths, {
				repoDir: ctx.cwd || process.cwd(), sessionDir: state.getSessionDir(), artifactRoot: root, exists: existsSync,
			}).map((item: any) => {
				if (!existsSync(item.path)) throw new Error(`Artifact not found: ${item.input} (resolved to ${item.path})`);
				return { ...item, preview: artifactPreviewFromText(readFileSync(item.path, "utf-8")) };
			});
		},
		appendInputArtifacts(task, artifacts) { return artifacts.length ? task + formatInputArtifactsSection(artifacts) : task; },
		writeRunArtifact(agentKey, runCount, output, kind = "returns") {
			const dir = safePathWithin(ensureArtifactsLayout(), kind);
			mkdirSync(dir, { recursive: true });
			const file = safePathWithin(dir, `${agentKey}-run${runCount}.md`);
			writeFileSync(file, output, "utf-8");
			return file;
		},
		evidencePathExists(evidencePath) {
			const raw = String(evidencePath || "").trim().replace(/\\/g, "/");
			const evidenceRoot = safePathWithin(artifactsRoot(), "evidence");
			let candidate: string | null = null;
			try {
				if (raw.startsWith("artifacts/evidence/")) candidate = safePathWithin(evidenceRoot, raw.slice("artifacts/evidence/".length));
				else if (raw.startsWith(".pi/agent-sessions/artifacts/evidence/")) candidate = safePathWithin(evidenceRoot, raw.slice(".pi/agent-sessions/artifacts/evidence/".length));
				else if (path.isAbsolute(raw)) {
					const resolved = path.resolve(raw);
					const relative = path.relative(evidenceRoot, resolved);
					if (!relative.startsWith("..") && !path.isAbsolute(relative)) candidate = resolved;
				}
			} catch { candidate = null; }
			return !!candidate && existsSync(candidate);
		},
		listArtifactFiles,
		renderArtifactIndexText,
		appendMachineHandoffSections(brief) {
			const sections: string[] = [];
			const ledger = renderAssertionLedgerText();
			if (ledger) sections.push(`## Verification ledger (verbatim, machine-appended)\n${ledger}`);
			const artifacts = renderArtifactIndexText();
			if (artifacts) sections.push(`## Artifact index\n${artifacts}`);
			return sections.length ? `${brief}\n\n${sections.join("\n\n")}` : brief;
		},
	};
}
