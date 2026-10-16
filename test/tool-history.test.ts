// Every case is converted with pi-ai's own Responses conversion and checked the way a strict endpoint checks it:
// each function_call has exactly one function_call_output, and every output has a call.
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { repairToolHistory } from "../tool-history.ts";

const model = { provider: "p", api: "openai-responses", id: "m", input: ["text"] } as any;
const a = (ids: string[], name = "ledger") => ({ role: "assistant", provider: "p", api: "openai-responses", model: "m", stopReason: "toolUse", content: ids.map((id) => ({ type: "toolCall", id, name, arguments: {} })) });
const r = (id: string) => ({ role: "toolResult", toolCallId: id, toolName: "ledger", content: [{ type: "text", text: "ok" }], isError: false });
const u = (t = "hi") => ({ role: "user", content: t });

function strictCheck(messages: any[]) {
	const items: any[] = convertResponsesMessages(model, { messages } as any, new Set(["p"]));
	const calls = new Map<string, number>(), outs = new Map<string, number>();
	for (const it of items) {
		if (it.type === "function_call") calls.set(it.call_id, (calls.get(it.call_id) ?? 0) + 1);
		if (it.type === "function_call_output") outs.set(it.call_id, (outs.get(it.call_id) ?? 0) + 1);
	}
	const problems: string[] = [];
	for (const [id, n] of calls) if (n !== 1) problems.push(`call ${id} appears ${n}x`);
	for (const [id, n] of outs) if (n !== 1) problems.push(`duplicate output ${id} (${n}x)`);
	for (const id of calls.keys()) if (!outs.has(id)) problems.push(`no output for ${id}`);
	for (const id of outs.keys()) if (!calls.has(id)) problems.push(`output without call ${id}`);
	return problems;
}

const eight = Array.from({ length: 8 }, (_, i) => `call_${i}abc|fc_${i}abc`);
const long = "call_" + "x".repeat(70);
const cases: Record<string, any[]> = {
	"normal round": [u(), a(["call_A|fc_A", "call_B|fc_B"]), r("call_A|fc_A"), r("call_B|fc_B")],
	"issue #4 shape: 3 single calls then 8 parallel": [u(), a(["call_t1|fc_t1"]), r("call_t1|fc_t1"), a(["call_t2|fc_t2"]), r("call_t2|fc_t2"), a(["call_f|fc_f"]), r("call_f|fc_f"), a(eight), ...eight.map(r)],
	"user message between calls and results": [u(), a(eight), u("hi again"), ...eight.map(r)],
	"user message between results": [u(), a(eight), r(eight[0]), u("hi again"), ...eight.slice(1).map(r)],
	"same call_id, different fc part": [u(), a(["call_A|fc_1", "call_A|fc_2"]), r("call_A|fc_1"), r("call_A|fc_2")],
	"same full id twice (issue #3)": [u(), a(["dup1", "dup1"]), r("dup1"), r("dup1")],
	"ids equal after 64-char cut": [u(), a([long + "1|fc_a", long + "2|fc_b"]), r(long + "1|fc_a"), r(long + "2|fc_b")],
	"same call_id reused in a later round": [u(), a(["call_A|fc_1"]), r("call_A|fc_1"), a(["call_A|fc_2"]), r("call_A|fc_2")],
	"duplicate result stored": [u(), a(["call_A|fc_A"]), r("call_A|fc_A"), r("call_A|fc_A")],
	"result without a call": [u(), a(["call_A|fc_A"]), r("call_A|fc_A"), r("call_Z|fc_Z")],
	"round left unanswered, then a user turn": [u(), a(["call_A|fc_A"]), u("next")],
};

let failed = 0;
for (const [name, msgs] of Object.entries(cases)) {
	const before = strictCheck(msgs);
	const { messages, report } = repairToolHistory(msgs as any);
	const after = strictCheck(messages);
	const userOrder = (m: any[]) => m.filter((x) => x.role === "user").map((x) => x.content).join("|");
	const kept = userOrder(messages) === userOrder(msgs); // no user message lost or reordered
	const ok = after.length === 0 && kept;
	if (!ok) failed++;
	console.log(`${ok ? "ok" : "not ok"} - ${name}${before.length ? `  (unrepaired: ${before[0]})` : ""}${after.length ? `  REPAIRED STILL: ${after.join("; ")}` : ""}${kept ? "" : "  USER MESSAGES CHANGED"}  ${JSON.stringify(report)}`);
}
console.log(`${failed} failed`);
process.exit(failed ? 1 : 0);
