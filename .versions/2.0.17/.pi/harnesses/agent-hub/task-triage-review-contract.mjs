// Harness-only review return instructions and evidence gate; never imported by product parser.
// This template is shown to the reviewer, not inserted into or substituted for its return.
export function reviewReturnTemplate({ planReturnPath, before, after, afterDiff, acceptancePath, checkPath, check, exitCode, inspectedRevision }) {
  const evidence = [
    `plan return ${JSON.stringify(planReturnPath)}`,
    `BEFORE bytes ${JSON.stringify(before)}`,
    `AFTER bytes ${JSON.stringify(after)}`,
    `before/after diff ${JSON.stringify(afterDiff)}`,
    `builder runtime acceptance ${JSON.stringify(acceptancePath)}`,
    `builder check ${JSON.stringify(checkPath)}`,
    `declared command ${JSON.stringify(check)}`,
    `exit code ${exitCode}`,
    `inspected revision ${JSON.stringify(inspectedRevision)}`,
    "why the plan and one-token change are adequate: <reviewer's own observation>",
  ].join("; ");
  return `VERDICT: APPROVE | VERDICT: REJECT (choose exactly one, as the first standalone line)
changed_files: [README-SYNTH.md — typo-only change, if independently confirmed]
assertions_proven:
- A1: independently checked plan, exact bytes, diff and runtime check — evidence: ${evidence}
assertions_unproven: []
assertions_failed: []
tests_run: [declared command and result observed in builder evidence, not run by reviewer]
open_risks: []
requires_user_decision: []`;
}

// Evaluate only the reviewer's actual parsed return and observed runtime facts.
export function reviewClosureUnmet({ process, verdict, parsed, requiredPaths, check, exitCode, inspectedRevision }) {
  const unmet = [];
  if (process?.obligations?.review?.status !== "satisfied") unmet.push("review obligation not satisfied");
  if (process?.accepted !== true) unmet.push("process closure not accepted");
  if (verdict !== "VERDICT: APPROVE") unmet.push("canonical first-line verdict is not APPROVE");
  const evidence = parsed?.assertions_proven?.find(entry => entry.id === "A1")?.evidence;
  if (typeof evidence !== "string") unmet.push("parsed A1 assertions_proven evidence field missing");
  // Exact JSON strings preserve quotes, backslashes and newlines on one parser entry line.
  const observed = typeof evidence === "string" ? evidence : "";
  const missing = requiredPaths.filter(path => !observed.includes(JSON.stringify(path)));
  if (missing.length) unmet.push(`parsed A1 evidence missing references: ${missing.join(", ")}`);
  if (!observed.includes(`declared command ${JSON.stringify(check)}`)) unmet.push("parsed A1 evidence missing exact declared command");
  if (!observed.includes(`exit code ${exitCode}`)) unmet.push("parsed A1 evidence missing exit code");
  if (!observed.includes(`inspected revision ${JSON.stringify(inspectedRevision)}`)) unmet.push("parsed A1 evidence missing inspected revision");
  return unmet;
}
