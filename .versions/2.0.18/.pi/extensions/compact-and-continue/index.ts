import type { CompactionResult, ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { Type } from 'typebox';

const DEFAULT_COMPACTION_INSTRUCTIONS = 'Preserve task goal, completed work, changed/read files, decisions, blockers, and next steps.';

const RequestCompactionParams = Type.Object({
	customInstructions: Type.Optional(Type.String({
		description: 'Instructions for the compaction summary. Include what must be preserved for continuing safely.',
	})),
	reason: Type.Optional(Type.String({
		description: 'Short explanation recorded in tool details for why immediate compaction was requested.',
	})),
	continuationPrompt: Type.Optional(Type.String({
		description: 'Self-contained summary of the remaining plan to execute after compaction. Do not copy the original prompt verbatim. Include the next concrete actions. If the original plan explicitly requires later compaction checkpoints, include them; otherwise do not repeat the same compaction request.',
	})),
});

function compact(ctx: ExtensionContext, customInstructions: string): Promise<CompactionResult> {
	return new Promise((resolve, reject) => {
		ctx.compact({
			customInstructions,
			onComplete: resolve,
			onError: reject,
		});
	});
}

export default function compactAndContinueExtension(pi: ExtensionAPI) {
	type PendingCompaction = {
		customInstructions: string;
		reason: string;
		continuationPrompt?: string;
	};

	const pendingCompactions: PendingCompaction[] = [];
	let compactionRunning = false;

	async function runQueuedCompactions(ctx: ExtensionContext): Promise<void> {
		if (compactionRunning || pendingCompactions.length === 0) {
			return;
		}

		compactionRunning = true;
		const pending = pendingCompactions.splice(0);
		const customInstructions = pending
			.map((item, index) => [
				`Queued compaction request ${index + 1}/${pending.length}.`,
				`Reason: ${item.reason}`,
				item.customInstructions,
			].join(' '))
			.join('\n\n');
		const continuationRequest = [...pending].reverse().find(item => item.continuationPrompt !== undefined);

		try {
			ctx.ui.notify('Compacting queued context request.', 'info');
			await compact(ctx, customInstructions);
			ctx.ui.notify('Queued compaction finished.', 'info');

			if (continuationRequest?.continuationPrompt) {
				ctx.ui.notify('Continuing summarized plan after compaction.', 'info');
				setTimeout(() => pi.sendUserMessage(continuationRequest.continuationPrompt!), 0);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Queued compaction failed: ${message}`, 'error');
		} finally {
			compactionRunning = false;
			if (pendingCompactions.length > 0) {
				setTimeout(() => void runQueuedCompactions(ctx), 0);
			}
		}
	}

	pi.on('agent_end', async (_event, ctx) => {
		if (pendingCompactions.length > 0 && !compactionRunning) {
			setTimeout(() => void runQueuedCompactions(ctx), 0);
		}
	});

	pi.registerTool({
		name: 'request_compaction',
		label: 'Request Compaction',
		description: 'Queue pi context compaction to run as soon as the current agent turn finishes. Use only when the user, a skill, or a prompt explicitly asks for compaction. If more work should continue after compaction, provide continuationPrompt as a concise summary of the remaining plan rather than the original prompt verbatim. This tool does not ask for confirmation; workflows that need confirmation must ask the user before calling it.',
		promptSnippet: 'request_compaction(customInstructions?, reason?, continuationPrompt?) - queue context compaction after the current turn, then optionally continue from a summarized remaining plan.',
		promptGuidelines: [
			'Use request_compaction only when compaction was explicitly requested by the user, skill, or prompt.',
			'If user confirmation is required, ask the user before calling request_compaction; this tool does not ask for confirmation.',
			'Use request_compaction when the user asks to compact now or before continuing to later steps in the same task.',
			'Provide customInstructions that preserve goals, decisions, files read/modified, blockers, and next steps.',
			'When work should continue after compaction, provide continuationPrompt as a concise, self-contained summary of the remaining plan; do not copy the original prompt verbatim.',
			'If the original plan explicitly requires later compaction checkpoints, include those checkpoints in continuationPrompt so request_compaction can be called again later; otherwise do not repeat the same compaction request.',
		],
		parameters: RequestCompactionParams,
		executionMode: 'sequential',
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const customInstructions = params.customInstructions?.trim() || DEFAULT_COMPACTION_INSTRUCTIONS;
			const reason = params.reason?.trim() || 'The current instructions requested immediate context compaction.';
			const continuationPrompt = params.continuationPrompt?.trim() || undefined;

			pendingCompactions.push({ customInstructions, reason, continuationPrompt });
			ctx.ui.notify(
				continuationPrompt
					? 'Compaction queued after the current turn. The summarized remaining plan will continue after compaction.'
					: 'Compaction queued after the current turn.',
				'info',
			);

			return {
				content: [{
					type: 'text',
					text: continuationPrompt
						? 'Compaction queued. It will run after this agent turn finishes, then the summarized remaining plan will continue.'
						: 'Compaction queued. It will run after this agent turn finishes.',
				}],
				details: { queued: true, continueAfterCompaction: continuationPrompt !== undefined, customInstructions, reason, continuationPrompt },
				terminate: true,
			};
		},
	});
}
