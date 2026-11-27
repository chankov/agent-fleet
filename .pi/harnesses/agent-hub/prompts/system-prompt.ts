import { MAX_OPEN_ASSERTIONS } from "../assertion-ledger.js";
import { CAPABILITY_PACKS, type CapabilityPack } from "../capability-packs.ts";
import { workModePrompt } from "../work-mode.ts";
import { ROLE_NAMES, ROLES, type RoleName } from "../config/roles.ts";
import { PRACTICE_IDS, PRACTICES } from "../config/practices.ts";
import { component, type ContextBudgetComponent } from "../../lib/context-budget.ts";
import { assembleHubSystemPrompt, HUB_HERDR_SECTION, namedHubLedgerParts, recordHubLedger } from "../../lib/context-budget-hub-prompt.ts";
import type { HubPromptContext } from "./context.ts";
import {
	ASK_SYSTEM1_RECOMMENDED_FRAGMENT,
 FILE_DISCOVERY_FRAGMENT,
	askUserFragment,
	COMPACTION_FRAGMENT,
	comsFragment,
	dispatchFragment,
	languageFragment,
	stateCapsuleFragment,
	TASK_TRIAGE_FRAGMENT,
	verificationFragment,
} from "./fragments.ts";

/** Each role's assignment and authority as the runtime enforces it (config/roles.ts, dispatch-access.ts). */
const ROLE_LINES: Readonly<Record<RoleName, string>> = Object.freeze({
	researcher: "read-only (read/grep/find/ls), via `spawn_research`",
	reviewer: "read-only, via `dispatch_agent`; never approves its author's work",
	editor: "writes only inside the declared scope, via `dispatch_agent`",
});

/** One line per role: its authority, default practice and the model it runs on. */
export function roleCards(ctx: Pick<HubPromptContext, "getAgents" | "getResearchPersonas">): { id: RoleName; text: string }[] {
	const installed = new Map<string, string | undefined>([
		...ctx.getAgents().map(agent => [agent.name.toLowerCase(), agent.model] as const),
		...ctx.getResearchPersonas().map(persona => [persona.name.toLowerCase(), persona.model] as const),
	]);
	return ROLE_NAMES.map(name => {
		const status = !installed.has(name) ? " · not installed" : installed.get(name) ? ` · ${installed.get(name)}` : "";
		return { id: name, text: `- \`${name}\` — ${ROLE_LINES[name]}. Default: ${ROLES[name].defaultPractices.join(", ")}${status}` };
	});
}

/** The code-owned practice catalog: id, roles when restricted, and the one-line expected result. */
export function practiceCatalog(): string {
	return PRACTICE_IDS.map(id => {
		const practice = PRACTICES[id];
		const roles = practice.roles.length < ROLE_NAMES.length ? ` (${practice.roles.join(", ")})` : "";
		const note = id === "release" ? " Publishing needs separate permission." : "";
		return `- \`${id}\`${roles} — ${practice.result}${note}`;
	}).join("\n");
}

export interface BuiltHubSystemPrompt {
	systemPrompt: string;
	ledger: ContextBudgetComponent[];
}

function capabilityStatus(pack: CapabilityPack, ctx: HubPromptContext, active: readonly CapabilityPack[], provisional: readonly CapabilityPack[]): string {
	if (active.includes(pack)) return "active";
	if (provisional.includes(pack)) return "provisional";
	if ((pack === "peer" && ctx.isComsReady()) || (pack === "workspace" && ctx.isHerdrFleetReady())) return "ready-inactive";
	return pack === "peer" || pack === "workspace" ? "unavailable" : "inactive";
}

/** Pure text and ledger assembly. Turn lifecycle resets are owned by index.ts. */
export function buildHubSystemPrompt(ctx: HubPromptContext): BuiltHubSystemPrompt {
	const resolution = ctx.getCapabilityResolution();
	const modelPacks = new Set<CapabilityPack>([...resolution.active, ...resolution.provisional]);
	const fleetActive = modelPacks.has("fleet");
	const verificationActive = modelPacks.has("verification");
	const peerActive = modelPacks.has("peer");
	const workspaceActive = modelPacks.has("workspace");
	const compactionActive = modelPacks.has("compaction");
	// The three roles and the practice catalog replace teams (PLAN-11-01, D7).
	const roles = fleetActive ? roleCards(ctx) : [];
	const roleCatalog = roles.map(card => card.text).join("\n");
	const practices = fleetActive ? practiceCatalog() : "";
	const providerLimits = fleetActive ? ctx.getProviderLimits?.() ?? [] : [];
	const providerLimitLine = providerLimits.length
		? `\n- Local model concurrency: ${providerLimits.map(limit => `\`${limit.provider}/\` at most ${limit.limit} parallel run${limit.limit === 1 ? "" : "s"}`).join("; ")}. Extra runs queue; choose another model when waiting would stall the task.`
		: "";
	const activeTools = ctx.getActiveTools();
	const askUserAvailable = activeTools.includes("ask_user");
	const userLanguage = ctx.getUserLanguage();
	const askUserBlock = askUserFragment(askUserAvailable, userLanguage);
	const triageBeforeDispatch = fleetActive && activeTools.includes("dispatch_triage") && ctx.getTriageBeforeDispatch?.() === true;
	const dispatchSection = dispatchFragment(fleetActive) + providerLimitLine + (triageBeforeDispatch ? `

## Enabled System 1 pre-dispatch advice
After resolving requirements and task classification, call \`dispatch_triage\` once for each focused task you intend to delegate, before choosing its \`dispatch_agent\` role. Send only minimal non-secret context, relative scope, and the actual language/domain. Do not read files or credentials merely to populate triage.
Then independently decide whether and whom to dispatch. An \`uncalibrated\` result contains experimental observations, NOT an approved recommendation; never invent a calibration profile. Do not ask the human solely because calibration is absent. All existing ambiguity, risk, permission, budget and acceptance rules still apply. Low predicted risk never means safe.
If triage abstains, fails, is unavailable, stale, or reaches its budget, use ordinary independent judgment without automatic retries or forcing a specialist. Do not delegate operator/research-only work just to exercise triage. When dispatching after an applicable result, include its \`triage_id\` and a truthful \`triage_reason\` (\`independent_judgment\` for uncalibrated observations). A triage result is never authorization to execute.
` : "");
	const languageLines = languageFragment(userLanguage, fleetActive);
	const busyProviders = providerLimits.filter(limit => limit.inFlight > 0 || limit.queued > 0);
	const catalogNotice = ctx.getToolCatalogNotice?.();
	const stateCapsule = stateCapsuleFragment(ctx.getPromptState(), resolution, askUserAvailable)
		+ (busyProviders.length ? `\n- local model slots in use: ${busyProviders.map(limit => `${limit.provider} ${limit.inFlight}/${limit.limit}${limit.queued ? ` (+${limit.queued} queued)` : ""}`).join(", ")}` : "")
		+ (catalogNotice ? `\n\n${catalogNotice}` : "");
	const agenticRecommended = activeTools.includes("ask_system1") && ctx.getAgenticAskMode?.() === "recommended";
	const stableModeSection = [fleetActive ? TASK_TRIAGE_FRAGMENT : "", agenticRecommended ? ASK_SYSTEM1_RECOMMENDED_FRAGMENT : "", activeTools.includes('ask_system1_files') ? FILE_DISCOVERY_FRAGMENT : ""].filter(Boolean).join("\n\n");
	const artifactRoot = ctx.getArtifactRoot?.();
	const verificationSection = (verificationActive ? verificationFragment(MAX_OPEN_ASSERTIONS) : "") +
		(artifactRoot && (verificationActive || fleetActive) ? `\n\nSession artifact root: ${artifactRoot}. Use this absolute root for read/write tools. Handoff paths artifacts/<kind>/... are relative to this root, not the repository. Legacy shared .pi/agent-sessions/artifacts paths belong to other sessions; do not overwrite them.` : "");
	const projectPolicySection = ctx.getRulesProtocol() + ctx.getDocsProtocol();
	const comsSection = comsFragment(peerActive, ctx.isComsReady(), ctx.getIdentity());
	const workModeText = workModePrompt();
	const herdrSection = workspaceActive && ctx.isHerdrFleetReady() ? HUB_HERDR_SECTION : "";
	const compactionSection = compactionActive ? COMPACTION_FRAGMENT : "";
	const systemPrompt = assembleHubSystemPrompt({
		intro: workModeText.intro,
		toolList: `these active packs: ${[...modelPacks].join(", ")}. Tools: ${activeTools.map(name => `\`${name}\``).join(", ") || "(none)"}`,
		languageLines,
		dispatchSection,
		askUserBlock,
		modeSection: stableModeSection,
		verificationSection,
		projectPolicySection,
		stateCapsule,
		comsSection,
		herdrSection,
		compactionSection,
		hardRules: workModeText.hardRules,
		roleCatalog,
		practiceCatalog: practices,
		delegationGuide: workModeText.delegationGuide,
	});
	const ledger = recordHubLedger(systemPrompt, namedHubLedgerParts({
		intro: workModeText.intro,
		languageLines,
		roleCards: roles,
		practiceCatalog: practices,
		dispatchSection: (fleetActive ? workModeText.delegationGuide : "") + dispatchSection,
		modeSection: stableModeSection,
		verificationSection,
		projectPolicySection,
		stateCapsule,
		comsSection,
		herdrSection,
		compactionSection,
	})).concat(CAPABILITY_PACKS.map(pack => {
		const status = capabilityStatus(pack, ctx, resolution.active, resolution.provisional);
		return component({
			id: `hub/capability/${pack}`, plane: "hub", category: "system", label: `Capability ${pack}: ${status}`,
			source: resolution.reasons[pack], persistence: "turn", visibility: "ui-only", confidence: "exact-chars", chars: 0,
		});
	}));
	return { systemPrompt, ledger };
}
