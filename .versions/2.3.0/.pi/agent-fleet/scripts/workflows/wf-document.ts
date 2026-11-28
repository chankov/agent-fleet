import type { Static } from "@sinclair/typebox";
import { runAgentPhase } from "./lib/agent-phase.ts";
import { asEnvelope as changesEnvelope, capture, type ChangeSet } from "./lib/changes.ts";
import { DocumentEnvelope as DocumentEnvelopeSchema, ENVELOPE_EXAMPLES, validateEnvelope } from "./lib/envelopes.ts";
import { artifactsExist, filesNonEmpty } from "./lib/gates.ts";
import { commitAll } from "./lib/git.ts";
import { snapshot, type PermissionSnapshot } from "./lib/permissions.ts";
import { logAssignment, resolveRole, withAssignment, type PersonaDefinition } from "./lib/personas.ts";
import type { FinishResult, Run } from "./lib/run.ts";

export type DocumentReport = Static<typeof DocumentEnvelopeSchema>;
export interface DocumentWorkflowDeps {
	agent?: (options: Parameters<typeof runAgentPhase<DocumentReport>>[0]) => Promise<DocumentReport>;
	capture?: (run: Run, params: { ref: string; cwd: string; maxDiffLines: number }) => ChangeSet;
	commit?: (message: string, cwd: string, baseline: PermissionSnapshot, policy: { writes?: string[] }) => string | null;
	persona?: PersonaDefinition & { assignment?: string };
	baseline?: PermissionSnapshot;
	baseRef?: string;
}
/**
 * The document phase is an editor with the documentation practice. The flow owns its
 * boundary, not the role file: documentation paths only, and no shell.
 */
export const DOCUMENT_ASSIGNMENT = { role: "editor", practices: ["documentation"], tools: "read,write,edit,grep,find,ls" } as const;
export const DOCUMENT_PERMISSION_POLICY = { writes: ["docs/", "**/*.md"] };
const resolveDocumentEditor = (cwd: string) => resolveRole(DOCUMENT_ASSIGNMENT.role, DOCUMENT_ASSIGNMENT.practices, cwd, { tools: DOCUMENT_ASSIGNMENT.tools });
export function documentWorkflowPreflight(cwd: string): void { resolveDocumentEditor(cwd); }
function dryDocument(): DocumentReport {
	const parsed = validateEnvelope<DocumentReport>("document", JSON.stringify(ENVELOPE_EXAMPLES.document));
	if (!parsed.ok) throw new Error(parsed.errors.join("; "));
	return parsed.value!;
}

/** Phases: code(changes) → agent(editor) → code(commit) */
export async function documentWorkflow(run: Run, input: { args: string[]; dryRun: boolean; cwd: string }, deps: DocumentWorkflowDeps = {}): Promise<FinishResult> {
	const persona = deps.persona ?? resolveDocumentEditor(input.cwd);
	const baseline = deps.baseline ?? run.repositoryBaseline ?? snapshot(input.cwd);
	const captureChanges = deps.capture ?? capture;
	const changes = await run.phase({ name: "changes", kind: "code", owner: "git", description: "Resolve and record the exact change set the documentation must explain" }, phase => {
		if (input.dryRun) {
			phase.log("clean tree — falling back to the last commit (HEAD~1)");
			return { base: { ref: deps.baseRef ?? "main", diffBase: "HEAD~1", reason: "clean tree — falling back to the last commit (HEAD~1)", scenario: "fallback" as const }, changedFiles: [], untrackedFiles: [], diff: "", hiddenLines: 0 };
		}
		return captureChanges(run, { ref: deps.baseRef ?? process.env.FLOW_BASE_REF ?? "main", cwd: input.cwd, maxDiffLines: 2000 });
	});
	const envelope = changesEnvelope(changes, input.args.join(" "));
	const task = withAssignment(`Document the captured repository changes accurately. Update only documentation allowed by your writes policy. The document_path must also be listed in artifacts so executable gates can inspect it.\n\nBase reason: ${changes.base.reason}\nChanged files: ${changes.changedFiles.join(", ") || "none"}\n\n${envelope.notes_for_next_agent}`, persona);
	const agent = deps.agent ?? runAgentPhase<DocumentReport>;
	const report = await run.phase({ name: "document", kind: "agent", owner: "editor", description: "Turn the deterministic change set into maintained project documentation" }, phase => { logAssignment(phase, persona); return input.dryRun ? dryDocument() : agent({ run, persona, task, envelope: "document", cwd: input.cwd, gates: [artifactsExist, filesNonEmpty], gateRetries: 1, permissionPolicy: DOCUMENT_PERMISSION_POLICY }); });
	await run.phase({ name: "commit", kind: "code", owner: "git", description: "Commit documentation only after its files pass executable gates" }, phase => {
		if (input.dryRun) return phase.log("dry-run: commit skipped");
		const hash = (deps.commit ?? commitAll)(report.commit_message, input.cwd, baseline, DOCUMENT_PERMISSION_POLICY);
		if (hash) phase.log("documentation committed", { hash });
		else phase.log("no documentation changes to commit; documentation was already accurate");
	});
	return run.finish({ accepted: true });
}
