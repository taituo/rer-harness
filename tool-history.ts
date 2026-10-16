// Tool history repair, applied to every request just before it is sent (issues #3 and #4).
//
// Strict OpenAI-compatible endpoints require every tool call in the history to have exactly one result. Two things can
// break that even when the stored transcript looks fine:
//
//  1. Two calls share a call_id. pi-ai sends a Responses call_id as the part of Pi's id before "|", cut to 64
//     characters, so ids that differ only after "|" or past 64 characters collide on the wire.
//  2. A user message sits between a round's calls and their results. pi-ai then adds a synthetic "No result provided"
//     for each unanswered call, and the real results follow: two outputs for one call_id.
//
// repairToolHistory makes the wire call_ids unique (rewriting the call and its matching result together), moves
// messages that interrupt a round to just after the round's results, and drops results that answer no pending call.
// It changes only the request; the stored transcript keeps what happened.

type Msg = { role: string; content?: any; toolCallId?: string; [k: string]: any };

/** The part of an id that becomes the wire call_id, normalized the way pi-ai does. */
function wireId(id: string): string {
	const part = id.split("|")[0];
	return part.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64).replace(/_+$/, "");
}

export type RepairReport = { renamed: number; moved: number; droppedResults: number };

export function repairToolHistory(messages: readonly Msg[]): { messages: Msg[]; report: RepairReport } {
	const report: RepairReport = { renamed: 0, moved: 0, droppedResults: 0 };

	// 1. Unique wire ids. Each occurrence of a call gets the next id in order; its result takes the matching one.
	const seen = new Set<string>();
	const pendingIds = new Map<string, string[]>(); // original full id -> new full ids, in call order
	const renamedMessages = messages.map((m) => {
		if (m.role === "assistant" && Array.isArray(m.content)) {
			let changed = false;
			const content = m.content.map((b: any) => {
				if (b.type !== "toolCall") return b;
				let id = b.id as string;
				let key = wireId(id);
				if (seen.has(key)) {
					const rest = id.includes("|") ? id.slice(id.indexOf("|")) : "";
					for (let n = 2; seen.has(key); n++) {
						key = `${wireId(id).slice(0, 56)}_d${n}`;
					}
					id = `${key}${rest}`;
					changed = true;
					report.renamed++;
				}
				seen.add(key);
				pendingIds.set(b.id, [...(pendingIds.get(b.id) ?? []), id]);
				return id === b.id ? b : { ...b, id };
			});
			return changed ? { ...m, content } : m;
		}
		if (m.role === "toolResult" && m.toolCallId) {
			const queue = pendingIds.get(m.toolCallId);
			const id = queue?.shift();
			return id && id !== m.toolCallId ? { ...m, toolCallId: id } : m;
		}
		return m;
	});

	// 2. Pairing: within a round, results come right after their calls; anything else waits until the round closes.
	const out: Msg[] = [];
	let pending = new Set<string>();
	let held: Msg[] = [];
	const release = () => {
		out.push(...held);
		held = [];
	};
	for (const m of renamedMessages) {
		if (m.role === "assistant") {
			release(); // a new turn: unanswered calls get pi-ai's synthetic result before it, as they should
			const calls = Array.isArray(m.content) ? m.content.filter((b: any) => b.type === "toolCall").map((b: any) => b.id as string) : [];
			pending = new Set(calls);
			out.push(m);
		} else if (m.role === "toolResult") {
			if (m.toolCallId && pending.has(m.toolCallId)) {
				pending.delete(m.toolCallId);
				out.push(m);
				if (pending.size === 0) release();
			} else report.droppedResults++;
		} else if (pending.size > 0) {
			if (m.role === "user") report.moved++;
			held.push(m);
		} else out.push(m);
	}
	release();
	return { messages: out, report };
}

/** Roles, tool ids and kinds of a request, without any content: safe to keep as a diagnostic. */
export function requestShape(messages: readonly Msg[]) {
	return messages.map((m) => {
		if (m.role === "assistant") return { role: m.role, calls: Array.isArray(m.content) ? m.content.filter((b: any) => b.type === "toolCall").map((b: any) => `${b.name}:${b.id}`) : [], stop: m.stopReason };
		if (m.role === "toolResult") return { role: m.role, id: m.toolCallId, tool: m.toolName, error: !!m.isError };
		return { role: m.role };
	});
}
