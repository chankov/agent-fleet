/** A review frame describes delivery, never authorization. Ordinary replies bypass this codec. */
export function reviewInstructions(id: string): string {
	return `\nReview protocol v1: make each update a standalone JSON object. Use msg_id ${JSON.stringify(id)} and phase "progress" for interim updates. Only when finished, use phase "final", verdict "APPROVE" or "REJECT", and report containing your complete review as a JSON string. Put all prose inside report. Only a final frame should be followed by a completion marker if requested.`;
}

type ReviewFrame = { wire: string; report: string; reason?: never } | { reason: 'wrong_id' | 'non_final' | 'unparseable' | 'ambiguous_wrap'; wire?: never; report?: never };

export function parseReview(value: unknown, id: string, pane = false): ReviewFrame {
	if (typeof value !== 'string') return { reason: 'unparseable' } as const;
	let text = value.trim();
	const marker = `<<COMS_DONE:${id}>>`;
	const lines = text.split(/\r?\n/);
	if (lines.at(-1)?.trim() === marker) text = lines.slice(0, -1).join('\n').trim();
	// Only unwrap a fence around the entire reply; never search prose for examples.
	// Scrollback may retain standalone progress updates above the final turn.
	// Skip only complete, correlated progress objects, never arbitrary prose.
	if (pane) {
		const rows = text.split('\n');
		let start = 0;
		while (start < rows.length - 1) {
			try {
				const previous = JSON.parse(rows[start]);
				if (previous?.phase !== 'progress' || parseReview(rows[start], id).reason !== 'non_final') break;
			} catch { break; }
			start++;
		}
		text = rows.slice(start).join('\n');
	}
	const fence = /^```(?:json)?\n([\s\S]*)\n```$/i.exec(text);
	text = fence?.[1] ?? text;
	try {
		// Herdr removes terminal soft wraps. Claude may also paint a single logical
		// line across screen rows; join those only when decoding a pane capture.
		const folds: number[] = [];
		if (pane) {
			let removed = 0;
			text = text.replace(/\r?\n(  )?/g, (wrap, indent, offset) => {
				if (indent) folds.push(offset - removed);
				removed += wrap.length;
				return '';
			});
		}
		const frame = JSON.parse(text);
		// JSON.parse silently keeps the last duplicate key. For a flat frame,
		// count member tokens (skipping quoted string values) before trusting it.
		const tokens = [...text.matchAll(/("(?:\\.|[^"\\])*")(\s*:)?/g)];
		const members = tokens.filter(token => token[2]);
		if (!frame || typeof frame !== 'object' || members.length !== Object.keys(frame).length) return { reason: 'unparseable' } as const;
		if (frame.msg_id !== id) return { reason: 'wrong_id' } as const;
		if (frame.phase !== 'final') return { reason: 'non_final' } as const;
		if (!['APPROVE', 'REJECT'].includes(frame.verdict) || typeof frame.report !== 'string' || !frame.report.trim()) return { reason: 'unparseable' } as const;
		// Screen rows with a hanging indent may split a word or replace a space.
		// Fixed protocol fields have known values. Free-form findings require exact text.
		if (folds.length) {
			const key = tokens.findIndex(token => token[2] && JSON.parse(token[1]) === 'report');
			const value = tokens[key + 1];
			if (key < 0 || !value) return { reason: 'unparseable' };
			const openingQuote = value.index;
			const closingQuote = openingQuote + value[1].length - 1;
			if (folds.some(offset => openingQuote < offset && offset <= closingQuote)) return { reason: 'ambiguous_wrap' };
		}
		return { wire: text, report: `${frame.report}\nVerdict: ${frame.verdict}` } as const;
	} catch { return { reason: 'unparseable' } as const; }
}
