import type { AfDebateResult } from "../debate-progress.ts";

/** A finished three-round debate: sol changed in round 2, grok failed in round 2, opus held and still refutes sol. */
export function debateFixture(panel = "default"): AfDebateResult {
	return {
		panel, question: "Extract the parser now?", rounds: 3, roundsRun: 3, complete: true,
		voices: [
			{ name: "sol", model: "a/sol", finalRound: 3, position: "Extract after the release.", changes: [{ round: 2, from: "Extract now.", evidence: ["opus: the release freeze in docs/release.md", "CI time"] }], alignedWith: ["opus"], refutes: [], path: "polls/r/debate/round-3/sol.md" },
			{ name: "grok", model: "b/grok", finalRound: 1, position: "Rewrite it.", changes: [], alignedWith: [], refutes: [], failedRound: 2, reason: "timeout", path: "polls/r/debate/round-2/grok.md" },
			{ name: "opus", model: "c/opus", finalRound: 3, position: "Extract after the release, behind a flag.", changes: [], alignedWith: ["sol"], refutes: ["sol's plan skips the flag"], path: "polls/r/debate/round-3/opus.md" },
		],
		disagreements: [{ voice: "opus", statement: "sol's plan skips the flag" }],
		roundDetails: [
			{ round: 1, directory: "polls/r/debate/round-1/", voices: [{ name: "sol", ok: true, path: "x" }, { name: "grok", ok: true, path: "x" }, { name: "opus", ok: true, path: "x" }] },
			{ round: 2, directory: "polls/r/debate/round-2/", voices: [{ name: "sol", ok: true, changed: true, path: "x" }, { name: "grok", ok: false, reason: "timeout", path: "x" }, { name: "opus", ok: true, path: "x" }] },
			{ round: 3, directory: "polls/r/debate/round-3/", voices: [{ name: "sol", ok: true, path: "x" }, { name: "opus", ok: true, path: "x" }] },
		],
		directory: "polls/r/debate/",
	};
}
