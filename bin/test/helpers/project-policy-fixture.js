import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FIXTURE_POLICY_MARKER = "FIXTURE_POLICY_MARKER";
export const FIXTURE_TASK = "Plan, implement, and review the sample status change.";

/**
 * Creates four hand-written target files. This is disposable test data, not a
 * catalogue install or an Agent Fleet repository policy.
 */
export function createProjectPolicyFixture(prefix = "agent-fleet-policy-") {
	const cwd = mkdtempSync(join(tmpdir(), prefix));
	const rulesDir = join(cwd, ".ai", "rules");
	mkdirSync(rulesDir, { recursive: true });
	writeFileSync(join(cwd, ".ai", "agent-fleet-overrides.md"), `## agent-hub
rules: .ai/rules
`);
	writeFileSync(join(rulesDir, "README.md"), `# Fixture policy index

For planning, implementation, or review of the sample status change, load
\`.ai/rules/status-change.md\`.

\`.ai/rules/reference-only.md\` is background for an unrelated archival task;
do not load it for the sample status change.
`);
	writeFileSync(join(rulesDir, "status-change.md"), `# Sample status change policy

The user task deliberately does not state this policy. For the sample status
change, include the exact marker \`${FIXTURE_POLICY_MARKER}\` in planning
acceptance criteria, edit verification notes, and review findings.
`);
	writeFileSync(join(rulesDir, "reference-only.md"), `# Unrelated archival reference

This reference applies only to archival migrations, never to the sample status
change. Its sentinel is UNRELATED_ARCHIVE_SENTINEL.
`);
	return {
		cwd,
		task: FIXTURE_TASK,
		rulesPaths: [".ai/rules"],
		applicableRule: ".ai/rules/status-change.md",
		unrelatedReference: ".ai/rules/reference-only.md",
		cleanup: () => rmSync(cwd, { recursive: true, force: true }),
	};
}
