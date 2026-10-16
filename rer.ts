// RER harness: Reverse Eureka Reconstruction on Pi Durable.
//
//   node rer.ts auto    <config>            the whole study, unattended: guess, every arm × run, export; restarts on crashes
//   node rer.ts design  <config>            designer drafts a question path from the target
//   node rer.ts freeze  <config>            hash every study file into freeze.json (commit it)
//   node rer.ts guess   <config> [--arm X]  leakage test: tool-less guessers see questions 1..k
//   node rer.ts run     <config> [--arm X] [--run N]   one run: doer walks the path, observers follow
//   node rer.ts export  <config> [--arm X] [--run N]   transcripts to markdown
//   node rer.ts models  <config> [--provider P]   which models exist and have credentials
//
// Flags: --faux (offline dry run with a fake model), --unfrozen (allow edits after freeze; recorded),
//        --allow-leaks (run even if the isolation canary fails; recorded).
//
// Everything study-specific lives in the config and the files it points to. Nothing doer-facing is in this file.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { calculateCost } from "@earendil-works/pi-ai/models";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { configure, createRegistry, defineDoc, defineExtension, defineTool, Harness, hook, ToolTask, watchEvents } from "@earendil-works/pi-durable";
import type { Conversation, EntryRecord, Submission } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";

const ctx = BACKGROUND_CONTEXT;
const here = dirname(new URL(import.meta.url).pathname);

/** Stops the study: a rerun cannot fix it (not frozen, not isolated, config mismatch). Exit code 3. */
class Fatal extends Error {}
class BudgetReached extends Error {}

// ---------- config ----------

type Role = { model: string; thinking?: string; instructions?: string };
/** start: state at the first step. schedule: step key -> state before that step (q1…, open1…). announce: push ids sent
 *  to the doer when its internet changes, so it is not left believing whatever doer.md said. */
type Network = { start?: "on" | "off"; schedule?: Record<string, "on" | "off">; announce?: { on?: string; off?: string } };
type Config = {
	name: string;
	runsDir: string;
	arms: Record<string, string>; // arm name -> step file (question path, or control prompts)
	pushes?: string; // push bank: "## id" sections
	autoPushes?: string[]; // push ids sent after every step, same for every arm
	afterPath?: string[]; // push ids sent as extra steps once the path ends (open phase)
	target?: string; // the known solution B: only the designer and informed observers see it
	workdir: string; // base dir; each run gets a neutral subdirectory
	sandbox?: { start?: string; shell?: string; net?: string; container?: string; forbiddenPaths?: string[] };
	network?: Network; // the doer's internet: off unless this says otherwise
	networkByArm?: Record<string, Network>; // per-arm override, e.g. the same schedule for both arms, or none for control
	doer: Role;
	observers?: (Role & { name: string; informed?: boolean })[];
	observerRounds?: number;
	observerTools?: boolean; // read-only access to the doer's full transcript and files (default true)
	blindSeesInformed?: boolean; // default false: blind observers never see what informed ones say
	designer?: Role;
	guessers?: { models: string[]; thinking?: string; cutoffs: number[]; repeats: number; prompt: string; shuffled?: boolean };
	budget?: { maxUsd?: number; maxTokens?: number }; // per run; maxTokens suits subscriptions (OpenCode Go) where dollars do not apply
	modelRetries?: number; // provider retries inside one model call (no new message to the model)
	retries?: number; // resubmissions after a call still failed; each is recorded
	inbox?: string;
	digest?: { maxToolChars?: number; maxChars?: number; includeThinking?: boolean };
	templates?: { observerStep?: string; informedTarget?: string }; // {step} {digest} {discussion} / {target}
	auto?: { runs?: number; arms?: string[]; guess?: boolean; maxRestarts?: number };
	live?: { port?: number; host?: string } | false;
	notify?: string; // shell command run on the host with $RER_MESSAGE, e.g. curl -d "$RER_MESSAGE" ntfy.sh/topic
};

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, fallback: string) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const valued = new Set(["--arm", "--run", "--provider"]);
const [command, configArg] = args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1]));
if (!command || !configArg) {
	console.error("usage: node rer.ts <auto|design|freeze|guess|run|export|models> <config.json> [--arm rer] [--run 1] [--provider opencode-go] [--faux]");
	process.exit(2);
}
const configPath = resolve(configArg);
const base = dirname(configPath);
const cfg: Config = JSON.parse(readFileSync(configPath, "utf8"));
const at = (p: string) => (isAbsolute(p) ? p : resolve(base, p));
const text = (p: string) => readFileSync(at(p), "utf8");
const stripComments = (s: string) => s.replace(/<!--[\s\S]*?-->/g, "");
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Steps: blocks separated by a line containing only "---". HTML comments are author notes and never sent. */
function steps(file: string): string[] {
	return stripComments(text(file)).split(/^---\s*$/m).map((s) => s.trim()).filter(Boolean);
}
/** Push bank: "## id" headings, body until the next heading. */
function pushBank(): Record<string, string> {
	if (!cfg.pushes) return {};
	const out: Record<string, string> = {};
	for (const part of stripComments(text(cfg.pushes)).split(/^## +/m).slice(1)) {
		const nl = part.indexOf("\n");
		out[part.slice(0, nl).trim()] = part.slice(nl + 1).trim();
	}
	return out;
}
const fill = (t: string, v: Record<string, string | number>) => t.replace(/\{(\w+)\}/g, (m, k) => (k in v ? String(v[k]) : m));
const T = {
	observerStep: "Step {step}, what the researcher did:\n\n{digest}{discussion}",
	informedTarget: "The work you are observing is heading, knowingly or not, toward this known result:\n\n{target}",
	...cfg.templates,
};
const instructions = (r: { instructions?: string }) => (r.instructions ? stripComments(text(r.instructions)).trim() || undefined : undefined);

// ---------- status and notifications ----------

const status: Record<string, unknown> = { study: cfg.name, phase: "starting", updatedAt: new Date().toISOString() };
function setStatus(change: Record<string, unknown>) {
	Object.assign(status, change, { updatedAt: new Date().toISOString() });
	try {
		mkdirSync(at(cfg.runsDir), { recursive: true });
		writeFileSync(at(`${cfg.runsDir}/status.json`), JSON.stringify(status, null, 2) + "\n");
	} catch {}
}
function notify(message: string) {
	console.log(`[notify] ${message}`);
	if (!cfg.notify) return;
	spawnSync("sh", ["-c", cfg.notify], { env: { ...process.env, RER_MESSAGE: `${cfg.name}: ${message}` }, timeout: 15000, stdio: "ignore" });
}

// ---------- models ----------

const faux = flag("faux");
function fauxId(m: string) {
	return m.replace(/[^a-zA-Z0-9.-]/g, "_");
}
const models = builtinModels();
if (faux) {
	const usdPerMTok = Number(process.env.RER_FAUX_COST ?? 0); // faux-only: make budget limits testable
		// One fake model per configured model, so per-role usage and the model-mismatch guard behave as in a real run.
	const ids = [...new Set([cfg.doer, cfg.designer, ...(cfg.observers ?? [])].filter(Boolean).map((r) => r!.model).concat(cfg.guessers?.models ?? []))].map(fauxId);
	const f = fauxProvider({ provider: "faux", models: ids.map((id) => ({ id, reasoning: true, cost: { input: usdPerMTok, output: usdPerMTok, cacheRead: 0, cacheWrite: 0 } })) as any, tokensPerSecond: Number(process.env.RER_FAUX_TPS ?? 0) || undefined });
	let n = 0;
	const respond = (context: any) => {
		const msgs = context.messages ?? [];
		const last = msgs[msgs.length - 1];
		const lastUser = [...msgs].reverse().find((m: any) => m.role === "user");
		const said = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
		const tools: string[] = msgs.flatMap((m: any) => (m.role === "system" ? (m.toolsAdded ?? []).map((t: any) => t.name ?? t) : []));
		if (tools.length && last?.role === "user") {
			// faux-only: RER_FAUX_TOOLS='[["bash",{...}],["read",{...}]]' plays these calls in order, to attack the sandbox
			const script = process.env.RER_FAUX_TOOLS ? (JSON.parse(process.env.RER_FAUX_TOOLS) as [string, any][]) : undefined;
			const call: [string, any] = tools.includes("bash")
				? (script ? script[n++ % script.length] : ["bash", { command: `echo step ${++n} && pwd && ls` }])
				: tools.includes("transcript") ? ([["transcript", { count: 3 }], ["files", {}], ["files", { path: "notes.txt" }], ["search", { pattern: "step" }], ["files", { path: "../../../etc/passwd" }]] as [string, any][])[n++ % 5] : [tools[0], {}];
			return fauxAssistantMessage(fauxToolCall(call[0], call[1]), { stopReason: "toolUse" });
		}
		return fauxAssistantMessage(fauxText(`[faux] responding to: ${said.slice(0, 80).replace(/\s+/g, " ")}`));
	};
	f.appendResponses(Array.from({ length: 20000 }, () => respond));
	models.setProvider(f.provider);
}
const ref = (m: string) => {
	if (faux) return { provider: "faux", modelId: fauxId(m) };
	const i = m.indexOf("/");
	if (i < 0) throw new Fatal(`model "${m}" must be provider/modelId`);
	return { provider: m.slice(0, i), modelId: m.slice(i + 1) };
};

// ---------- paths and isolation ----------

/** Resolve symlinks of the longest existing prefix; a dangling symlink resolves to null (refused). */
function realish(p: string): string | null {
	const rest: string[] = [];
	let cur = p;
	for (;;) {
		try {
			lstatSync(cur);
			break;
		} catch {
			rest.unshift(basename(cur));
			const up = dirname(cur);
			if (up === cur) break;
			cur = up;
		}
	}
	try {
		return join(realpathSync(cur), ...rest);
	} catch {
		return null;
	}
}
const inside = (root: string, p: string) => {
	const r = relative(root, p);
	return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};
/** Real path of `p` if it stays inside `root` after following every symlink, else null. */
function within(root: string, p: string): string | null {
	const real = realish(resolve(root, p));
	return real && inside(realpathSync(root), real) ? real : null;
}

const forbidden = () => [base, here, ...(cfg.sandbox?.forbiddenPaths ?? []).map(at)];

/** The doer's file tools run on the host, so they may only touch its workdir, symlinks resolved.
 *  Bash output spilled to a host temp file is the doer's own, so exactly those files are readable too. */
function guard(workdir: string) {
	const spills = new Set<string>();
	return defineExtension({
		name: "rer.guard",
		hooks: [
			hook(ToolTask, {
				beforeTool: (call: any) => {
					const p = call.arguments?.path;
					if (typeof p !== "string" || ["bash", "powershell"].includes(call.name)) return undefined;
					if (spills.has(resolve(workdir, p)) && call.name === "read") return undefined;
					return within(workdir, p) ? undefined : { block: `Path is outside the project directory: ${p}` };
				},
				afterTool: (_call: any, result: any) => {
					const spill = result?.structuredOutput?.fullOutputPath;
					if (typeof spill === "string") spills.add(spill);
					return undefined;
				},
			}),
		],
	});
}

function makeEnv(workdir: string) {
	const shell = cfg.sandbox?.shell ? at(cfg.sandbox.shell) : undefined;
	if (cfg.sandbox?.container) process.env.RER_SANDBOX = cfg.sandbox.container;
	return new NodeExecutionEnv({ cwd: workdir, shellPath: shell });
}

/** Switch the doer's internet with the sandbox's net script; returns the state the container reports. */
function setNetwork(to: "on" | "off"): string {
	const r = spawnSync(at(cfg.sandbox!.net!), [to, cfg.sandbox?.container ?? "rer-sandbox"], { encoding: "utf8" });
	if (r.status !== 0) throw new Error(`network ${to} failed: ${r.stderr}`);
	const actual = r.stdout.trim().split("\n").pop() ?? "unknown";
	if (actual !== to) throw new Fatal(`asked for internet ${to}, the sandbox reports ${actual}`);
	return actual;
}
async function probeInternet(workdir: string) {
	const r: any = await makeEnv(workdir).exec("curl -sS -m 8 -o /dev/null https://example.com", {}, ctx);
	return r.ok && r.value.exitCode === 0;
}

/** Runs through the same shell as the doer's bash. Every leak probe must fail, and the positive control must pass:
 *  a broken sandbox shell fails everything, which would otherwise look like perfect isolation. The path guard is
 *  attacked with a real symlink to the study directory. */
async function canary(workdir: string) {
	const env = makeEnv(workdir);
	const exec = async (cmd: string) => {
		const r: any = await env.exec(cmd, {}, ctx);
		return r.ok ? (r.value.exitCode as number) : -1;
	};
	const shellWorks = (await exec(`echo ok > .rer-canary && test "$(cat .rer-canary)" = ok && rm .rer-canary`)) === 0;
	const probes: Record<string, string> = {
		curl: "curl -sS -m 5 -o /dev/null https://example.com",
		python: "python3 -c \"import urllib.request; urllib.request.urlopen('https://example.com', timeout=5)\"",
		dns: "getent hosts example.com",
		pip: "pip download --no-deps -d /tmp/rer-canary six -q",
		...Object.fromEntries(forbidden().map((p, i) => [`fs${i}:${p}`, `test -e '${p}'`])),
	};
	const results: Record<string, "leak" | "blocked"> = {};
	for (const [name, cmd] of Object.entries(probes)) results[name] = (await exec(cmd)) === 0 ? "leak" : "blocked";
	const link = join(workdir, ".rer-canary-link");
	spawnSync("ln", ["-sfn", base, link]);
	results["guard:symlink"] = within(workdir, ".rer-canary-link/experiment.json") ? "leak" : "blocked";
	results["guard:parent"] = within(workdir, "../") ? "leak" : "blocked";
	spawnSync("rm", ["-f", link]);
	return { shellWorks, results, isolated: shellWorks && Object.values(results).every((v) => v === "blocked") };
}

// ---------- harness ----------

let current: Harness | undefined;
process.on("SIGINT", async () => {
	console.error("\ninterrupted; state is saved, rerun the same command to continue");
	if (current) await current.close(ctx).catch(() => {});
	process.exit(130);
});

async function open(file: string) {
	mkdirSync(dirname(file), { recursive: true });
	const registry = createRegistry();
	registry.install(CodingTools);
	const harness = await Harness.open(await openNodeSqliteStorage(file), {
		models,
		registry,
		env: ({ cwd }: any) => makeEnv(cwd ?? process.cwd()),
		settings: {
			extensions: [],
			retry: { enabled: true, maxRetries: cfg.modelRetries ?? 8, baseDelayMs: 5000, maxAgentDelayMs: 300_000 },
		},
	} as any, ctx);
	current = harness;
	harness.resume();
	return { harness, registry };
}
async function close(harness: Harness) {
	await harness.close(ctx);
	if (current === harness) current = undefined;
}

/** Conversation ids by name, in one Session document: created once, found again on every later run. */
const Names = defineDoc<Record<string, string>>({ kind: "rer.names", version: 1, scope: "session", initial: () => ({}) });

async function named(harness: Harness, name: string, agent: any): Promise<Conversation> {
	const anchor = await harness.root(ctx);
	const id = await anchor.commit(async (tx) => {
		const names = await tx.doc(Names);
		if (names[name]) return names[name];
		const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
		await configure(tx, created.id, agent);
		names[name] = created.id as string;
		return names[name];
	}, ctx);
	const c = (await harness.conversation(id as any, ctx))!;
	// A resumed run must use what the config says now; a silent mismatch would make the record lie.
	const stored = (await c.agent(ctx)).model;
	if (stored && (stored.provider !== agent.model.provider || stored.modelId !== agent.model.modelId))
		throw new Fatal(`${name} was started with ${stored.provider}/${stored.modelId}, config now says ${agent.model.provider}/${agent.model.modelId}; use a new --run`);
	return c;
}

async function lookup(harness: Harness, name: string): Promise<Conversation | undefined> {
	const anchor = await harness.root(ctx);
	const id = (await anchor.commit(async (tx) => (await tx.doc(Names))[name], ctx)) as string | undefined;
	return id ? harness.conversation(id as any, ctx) : undefined;
}

const agentFor = (r: Role, extra?: string, ext?: any) => ({
	model: ref(r.model),
	thinkingLevel: (r.thinking ?? "high") as any,
	extensions: ext ? [ext] : [],
	tools: ext ? undefined : [],
	instructions: [instructions(r), extra].filter(Boolean).join("\n\n") || undefined,
});

async function entries(c: Conversation): Promise<EntryRecord[]> {
	const out: EntryRecord[] = [];
	let cursor: any;
	do {
		const page = await c.entries({ order: "ascending" }, 500, cursor, ctx);
		out.push(...page.items);
		cursor = page.next;
	} while (cursor);
	return out;
}

/** Ask and wait. The same requestId on a rerun returns the stored answer instead of asking again. Provider errors are
 *  retried inside the call by Pi; only a call that still fails is resubmitted, and that is recorded. */
async function ask(c: Conversation, requestId: string, content: string, extra: object = {}, during?: () => Promise<void>) {
	for (let attempt = 0; attempt <= (cfg.retries ?? 1); attempt++) {
		const rid = attempt ? `${requestId}#${attempt}` : requestId;
		const sub: Submission = await c.submit({ type: "input", content, requestId: rid, ...extra } as any, ctx);
		const waiting = sub.wait(ctx);
		let done = false;
		waiting.then(() => (done = true), () => (done = true));
		while (during && !done) {
			await Promise.race([waiting.catch(() => {}), sleep(2000)]);
			if (!done) await during();
		}
		const settled: any = await waiting;
		if (settled.status === "done") return answerText(c, settled.answer);
		console.error(`  ${requestId}: unanswered (${settled.reason}${settled.detail ? `: ${JSON.stringify(settled.detail).slice(0, 300)}` : ""})`);
		if (attempt < (cfg.retries ?? 1)) await c.submit({ type: "write", requestId: `retry:${rid}`, entry: { kind: "rer.retry", data: { requestId, reason: settled.reason, detail: settled.detail ?? null } } } as any, ctx);
	}
	throw new Error(`${requestId} failed after retries; it will be retried on the next start`);
}

async function answerText(c: Conversation, entryId: string) {
	const page = await c.entries({ minEntryId: entryId as any, maxEntryId: entryId as any }, 1, undefined, ctx);
	return render([...page.items], { includeThinking: false, maxToolChars: 0 });
}

function render(list: EntryRecord[], o: { includeThinking?: boolean; maxToolChars?: number; user?: string } = cfg.digest ?? {}): string {
	const max = o.maxToolChars ?? 4000;
	const cut = (s: string) => (max && s.length > max ? `${s.slice(0, max)}\n…[${s.length - max} chars cut]` : s);
	const lines: string[] = [];
	for (const e of list) {
		if (e.kind.startsWith("rer.") && !e.model) continue; // bookkeeping the model never saw
		for (const m of (e.model ?? []) as any[]) {
			const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? []);
			for (const b of blocks) {
				if (b.type === "text" && b.text?.trim()) lines.push(m.role === "toolResult" ? `[result] ${cut(b.text)}` : m.role === "user" ? `${o.user ?? "[to researcher]"} ${b.text}` : b.text);
				else if (b.type === "thinking" && o.includeThinking && b.thinking?.trim()) lines.push(`[thinking] ${b.thinking}`);
				else if (b.type === "toolCall") lines.push(`[${b.name}] ${cut(JSON.stringify(b.arguments))}`);
			}
		}
	}
	return lines.join("\n\n");
}
/** Keep a digest within an observer's context: the start and the (more informative) end of the step. */
function capTotal(s: string, max = cfg.digest?.maxChars ?? 60_000) {
	if (s.length <= max) return s;
	const head = Math.floor(max * 0.3);
	return `${s.slice(0, head)}\n\n…[${s.length - max} chars of this step omitted; use your tools to read them]…\n\n${s.slice(s.length - (max - head))}`;
}

/** Cost from token counts and the catalog's prices, not from what a provider reports (some report nothing). */
async function costUsd(harness: Harness) {
	const u: any = await harness.usage(ctx);
	let total = 0;
	for (const [key, usage] of Object.entries(u.models ?? {}) as [string, any][]) {
		const i = key.indexOf("/");
		const model = models.getModel(key.slice(0, i), key.slice(i + 1));
		total += model ? calculateCost(model, usage).total : (usage?.cost?.total ?? 0);
	}
	for (const v of Object.values(u.tools ?? {}) as any[]) total += v?.cost?.total ?? 0;
	return total;
}

async function tokensUsed(harness: Harness) {
	const u: any = await harness.usage(ctx);
	return Object.values(u.models ?? {}).reduce((n: number, v: any) => n + (v?.totalTokens ?? 0), 0) as number;
}

/** Fail before starting, not after retries: every model must exist in the catalog and have credentials. */
async function preflight(roles: string[]) {
	if (faux) return;
	for (const m of new Set(roles)) {
		const { provider, modelId } = ref(m);
		if (!models.getModel(provider, modelId)) throw new Fatal(`unknown model ${m}`);
		if (!(await models.getAuth(provider).catch(() => undefined))) throw new Fatal(`no credentials for ${provider} (needed by ${m}); set its API key`);
	}
}

// ---------- observer tools: read-only view of the doer's full transcript and files ----------

function observeTools(getDoer: () => Promise<Conversation>, workdir: string) {
	const out = (t: string) => ({ output: [{ type: "text" as const, text: t }] });
	const listFiles = (dir: string, acc: string[] = []) => {
		for (const name of readdirSync(dir).sort()) {
			if ([".git", "node_modules", "__pycache__", ".venv"].includes(name)) continue;
			const p = join(dir, name);
			const st = lstatSync(p);
			if (st.isSymbolicLink()) continue;
			if (st.isDirectory()) listFiles(p, acc);
			else acc.push(p);
			if (acc.length >= 2000) break;
		}
		return acc;
	};
	const readable = (p: string) => {
		const st = statSync(p);
		if (st.size > 2_000_000) return undefined;
		const buf = readFileSync(p);
		return buf.subarray(0, 8000).includes(0) ? undefined : buf.toString("utf8");
	};
	const transcriptLines = async () => {
		const all = await entries(await getDoer());
		return all.map((e) => render([e], { includeThinking: true, maxToolChars: 0 })).filter(Boolean).map((text, i) => ({ i, text }));
	};
	return defineExtension({
		name: "rer.observe",
		tools: [
			defineTool({
				name: "transcript",
				description: "Read the researcher's full transcript so far: their messages, reasoning, tool calls and complete tool outputs. Entries are numbered. Without arguments, shows the latest entries.",
				parameters: Type.Object({ from: Type.Optional(Type.Number()), count: Type.Optional(Type.Number()) }),
				execute: async (a: any) => {
					const all = await transcriptLines();
					const count = Math.min(a.count ?? 20, 100);
					const from = Math.max(0, a.from ?? all.length - count);
					const shown = all.slice(from, from + count);
					return out(`${all.length} entries; showing ${from}–${from + shown.length - 1}.\n\n${shown.map((x) => `#${x.i}\n${x.text}`).join("\n\n")}`);
				},
			}),
			defineTool({
				name: "files",
				description: "List the researcher's project files (no path), or read one file (path relative to the project; offset/limit in characters). Read-only.",
				parameters: Type.Object({ path: Type.Optional(Type.String()), offset: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()) }),
				execute: async (a: any) => {
					if (!a.path) return out(listFiles(workdir).map((p) => relative(workdir, p)).join("\n") || "(empty)");
					const p = within(workdir, a.path);
					if (!p || !existsSync(p)) throw new Error(`no such file in the project: ${a.path}`);
					if (statSync(p).isDirectory()) return out(listFiles(p).map((f) => relative(workdir, f)).join("\n") || "(empty)");
					const t = readable(p);
					if (t === undefined) throw new Error("binary or larger than 2 MB");
					const offset = a.offset ?? 0;
					const limit = Math.min(a.limit ?? 50_000, 200_000);
					return out(`${t.length} chars; showing ${offset}–${Math.min(t.length, offset + limit)}\n\n${t.slice(offset, offset + limit)}`);
				},
			}),
			defineTool({
				name: "search",
				description: "Search the researcher's transcript and project files with a regular expression (case-insensitive). Returns matching lines with where they are.",
				parameters: Type.Object({ pattern: Type.String(), in: Type.Optional(Type.Union([Type.Literal("transcript"), Type.Literal("files"), Type.Literal("both")])) }),
				execute: async (a: any) => {
					const re = new RegExp(a.pattern, "i");
					const hits: string[] = [];
					const where = a.in ?? "both";
					if (where !== "files")
						for (const x of await transcriptLines())
							for (const line of x.text.split("\n")) if (re.test(line) && hits.length < 200) hits.push(`transcript #${x.i}: ${line.slice(0, 300)}`);
					if (where !== "transcript")
						for (const f of listFiles(workdir)) {
							const t = readable(f);
							if (t === undefined) continue;
							t.split("\n").forEach((line, n) => re.test(line) && hits.length < 200 && hits.push(`${relative(workdir, f)}:${n + 1}: ${line.slice(0, 300)}`));
						}
					return out(hits.length ? hits.join("\n") : "no matches");
				},
			}),
		],
	});
}

// ---------- live view ----------

/** Serves live.html and a stream of every conversation's agent events from this process (the only storage owner). */
function startLive(harness: Harness, convs: Record<string, Conversation>, say: (to: string, message: string) => boolean) {
	if (cfg.live === false) return () => {};
	const port = cfg.live?.port ?? 7777;
	const host = cfg.live?.host ?? "127.0.0.1";
	const server = createServer(async (req, res) => {
		if (req.url === "/status") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(status));
		if (req.url === "/say" && req.method === "POST") {
			let body = "";
			req.on("data", (d) => (body += d));
			req.on("end", () => {
				try {
					const { to, text: message } = JSON.parse(body);
					res.writeHead(say(String(to), String(message)) ? 200 : 400).end();
				} catch {
					res.writeHead(400).end();
				}
			});
			return;
		}
		if (req.url !== "/events") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(readFileSync(join(here, "live.html")));
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
		send({ type: "status", status, conversations: Object.keys(convs) });
		const streams = await Promise.all(Object.entries(convs).map(async ([name, c]) => {
			const s = await watchEvents(harness, c.id, ctx);
			send({ conv: name, events: [s.snapshot] });
			s.start(async (events) => void send({ conv: name, events }));
			return s;
		}));
		const tick = setInterval(() => send({ type: "status", status }), 2000);
		req.on("close", () => {
			clearInterval(tick);
			for (const s of streams) s.stop().catch(() => {});
		});
	});
	server.on("error", (e) => console.error(`live view unavailable: ${(e as Error).message}`));
	server.listen(port, host, () => console.log(`live view: http://${host}:${port}`));
	return () => server.close();
}

// ---------- freeze ----------

function studyFiles(): string[] {
	const files = new Set<string>([configPath]);
	const add = (p?: string) => p && files.add(at(p));
	Object.values(cfg.arms).forEach(add);
	[cfg.pushes, cfg.target, cfg.doer.instructions, cfg.designer?.instructions, cfg.guessers?.prompt].forEach(add);
	cfg.observers?.forEach((o) => add(o.instructions));
	for (const s of [cfg.sandbox?.shell, cfg.sandbox?.start, cfg.sandbox?.net]) {
		if (!s || !existsSync(at(s))) continue;
		const dir = dirname(at(s));
		for (const f of readdirSync(dir)) if (statSync(join(dir, f)).isFile()) files.add(join(dir, f)); // shell, start, Dockerfile
	}
	for (const f of ["rer.ts", "live.html", "package-lock.json"]) files.add(join(here, f));
	return [...files].filter(existsSync).sort();
}
const fingerprint = () => Object.fromEntries(studyFiles().map((f) => [relative(base, f), sha(readFileSync(f))]));
const versions = () =>
	Object.fromEntries(["pi-durable", "pi-ai", "chord"].map((p) => {
		try {
			return [p, JSON.parse(readFileSync(join(here, "node_modules/@earendil-works", p, "package.json"), "utf8")).version];
		} catch {
			return [p, "unknown"];
		}
	}));

/** One freeze file per config, so two configs over the same study files (say Anthropic and OpenCode Go) do not clash. */
const freezeFile = () => join(base, `${basename(configPath, ".json")}.freeze.json`);

function checkFrozen(): { frozen: boolean; diff: string[] } {
	const f = freezeFile();
	if (!existsSync(f)) return { frozen: false, diff: [`${basename(f)} missing`] };
	const frozen = JSON.parse(readFileSync(f, "utf8")).files as Record<string, string>;
	const now = fingerprint();
	const diff = [...new Set([...Object.keys(frozen), ...Object.keys(now)])].filter((k) => frozen[k] !== now[k]);
	return { frozen: diff.length === 0, diff };
}

// ---------- commands ----------

async function design() {
	if (!cfg.designer || !cfg.target) throw new Fatal("config needs designer and target");
	await preflight([cfg.designer.model]);
	const { harness } = await open(at(`${cfg.runsDir}/${cfg.name}-design${faux ? "-faux" : ""}.sqlite`));
	const c = await named(harness, "designer", agentFor(cfg.designer));
	const out = await ask(c, `design:${sha(text(cfg.target)).slice(0, 12)}`, stripComments(text(cfg.target)));
	const file = at(`${cfg.runsDir}/questions.draft.md`);
	writeFileSync(file, out + "\n");
	console.log(`draft written to ${file}\nedit it, save as your arm's step file, then: node rer.ts freeze ${configArg}`);
	await close(harness);
}

function freeze() {
	const record = { frozenAt: new Date().toISOString(), versions: versions(), files: fingerprint() };
	writeFileSync(freezeFile(), JSON.stringify(record, null, 2) + "\n");
	console.log(`froze ${Object.keys(record.files).length} files into ${relative(process.cwd(), freezeFile())}; commit it before running:`);
	for (const [f, h] of Object.entries(record.files)) console.log(`  ${h.slice(0, 12)}  ${f}`);
}

const guessFile = (arm: string) => at(`${cfg.runsDir}/${cfg.name}-${arm}-guesses${faux ? "-faux" : ""}.jsonl`);

async function guess(arm: string) {
	const g = cfg.guessers;
	if (!g) throw new Fatal("config needs guessers");
	if (!cfg.arms[arm]) throw new Fatal(`unknown arm ${arm}`);
	await preflight(g.models);
	const qs = steps(cfg.arms[arm]);
	const prompt = stripComments(text(g.prompt)).trim();
	const { harness } = await open(at(`${cfg.runsDir}/${cfg.name}-${arm}-guess${faux ? "-faux" : ""}.sqlite`));
	const lines: string[] = [];
	const orders: Record<string, string[]> = { path: qs };
	if (g.shuffled) orders.shuffled = seededShuffle(qs, sha(cfg.name));
	setStatus({ phase: "guess", arm });
	for (const [order, list] of Object.entries(orders))
		for (const model of g.models)
			for (const k of g.cutoffs.filter((k) => k <= list.length))
				for (let r = 0; r < g.repeats; r++) {
					const name = `guess:${order}:${model}:${k}:${r}`;
					const c = await named(harness, name, agentFor({ model, thinking: g.thinking }));
					const shown = list.slice(0, k).map((q, i) => `${i + 1}. ${q}`).join("\n\n");
					const answer = await ask(c, name, `${prompt}\n\n${shown}`);
					lines.push(JSON.stringify({ arm, order, model, k, repeat: r, answer }));
					console.log(`  guess ${arm} ${order} ${model} k=${k} r=${r}`);
				}
	writeFileSync(guessFile(arm), lines.join("\n") + "\n");
	console.log(`guesses in ${guessFile(arm)}; score them blind (0 unrelated, 1 same area, 2 identifies the target)`);
	await close(harness);
}

function seededShuffle<T>(list: T[], seed: string): T[] {
	const a = [...list];
	let s = parseInt(seed.slice(0, 8), 16);
	for (let i = a.length - 1; i > 0; i--) {
		s = (s * 1664525 + 1013904223) >>> 0;
		const j = s % (i + 1);
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

function runId(arm: string, run: string) {
	if (!cfg.arms[arm]) throw new Fatal(`unknown arm ${arm}; config has ${Object.keys(cfg.arms).join(", ")}`);
	const id = `${cfg.name}-${arm}-${run}`;
	// Neutral directory name: nothing about the study, the arm, or the target reaches the doer through its cwd.
	const workdir = resolve(at(cfg.workdir), `p${sha(id).slice(0, 8)}`);
	const stem = at(`${cfg.runsDir}/${id}${faux ? "-faux" : ""}`);
	return { id, workdir, db: `${stem}.sqlite`, doneFile: `${stem}.done.json`, exportDir: stem };
}

async function run(arm: string, runNo: string) {
	const { id, workdir, db, doneFile } = runId(arm, runNo);
	const frozen = checkFrozen();
	if (!frozen.frozen && !flag("unfrozen") && !faux) throw new Fatal(`study files changed since freeze: ${frozen.diff.join(", ")} (refreeze, or pass --unfrozen to record it)`);
	await preflight([cfg.doer.model, ...(cfg.observers ?? []).map((o) => o.model)]);
	mkdirSync(workdir, { recursive: true });
	console.log(`workdir ${workdir}`);
	setStatus({ phase: "isolation", arm, run: runNo, id });
	if (cfg.sandbox?.start) {
		const started = spawnSync(at(cfg.sandbox.start), [workdir, cfg.sandbox.container ?? "rer-sandbox"], { stdio: "inherit" });
		if (started.status !== 0) throw new Error(`sandbox start failed (exit ${started.status})`);
	}
	if (cfg.sandbox?.net) setNetwork("off"); // isolation is always checked with the internet off
	const iso = await canary(workdir);
	console.log(`isolation: shell ${iso.shellWorks ? "works" : "BROKEN"}, ${JSON.stringify(iso.results)}`);
	if (!iso.shellWorks) throw new Fatal("the doer's shell does not run in the workdir (is the sandbox container up? sandbox/start.sh <workdir>)");
	if (!iso.isolated && !flag("allow-leaks") && !faux) throw new Fatal("isolation canary failed; fix the sandbox or pass --allow-leaks to record it");

	const pushes = pushBank();
	const pick = (pid: string) => {
		if (!pushes[pid]) throw new Fatal(`push "${pid}" not in ${cfg.pushes}`);
		return pushes[pid];
	};
	const plan = [
		...steps(cfg.arms[arm]).map((t, i) => ({ key: `q${i + 1}`, text: t, entry: undefined as any })),
		...(cfg.afterPath ?? []).map((pid, i) => ({ key: `open${i + 1}`, text: pick(pid), entry: { kind: "rer.push", data: { id: pid, phase: "open" } } })),
	];
	(cfg.autoPushes ?? []).forEach(pick);
	const net: Network = cfg.networkByArm?.[arm] ?? cfg.network ?? {};
	const usesNet = net.start === "on" || Object.values(net.schedule ?? {}).includes("on");
	for (const key of Object.keys(net.schedule ?? {})) if (!plan.some((p) => p.key === key)) throw new Fatal(`network.schedule names step "${key}", which this arm does not have (${plan.map((p) => p.key).join(", ")})`);
	Object.values(net.announce ?? {}).forEach((pid) => pid && pick(pid));

	const { harness, registry } = await open(db);
	const guardExt = guard(workdir);
	registry.install(guardExt);
	const doer = await named(harness, "doer", {
		model: ref(cfg.doer.model),
		thinkingLevel: (cfg.doer.thinking ?? "xhigh") as any,
		extensions: [CodingTools, guardExt],
		instructions: instructions(cfg.doer),
		cwd: workdir,
	});
	const write = (requestId: string, kind: string, data: object) => doer.submit({ type: "write", requestId, entry: { kind, data } } as any, ctx);
	await write(`meta:${Date.now()}`, "rer.session", {
		arm, run: runNo, startedAt: new Date().toISOString(), faux, frozen: frozen.frozen, frozenDiff: frozen.diff,
		isolation: iso, versions: versions(), files: fingerprint(), config: cfg,
	});

	const observeExt = cfg.observerTools === false ? undefined : observeTools(async () => doer, workdir);
	if (observeExt) registry.install(observeExt);
	// Blind observers speak first, so informed ones can respond to them without blind ones ever hearing the target.
	const ordered = [...(cfg.observers ?? [])].sort((a, b) => Number(!!a.informed) - Number(!!b.informed));
	const observers = [];
	for (const o of ordered) {
		const extra = o.informed && cfg.target ? fill(T.informedTarget, { target: stripComments(text(cfg.target)).trim() }) : undefined;
		observers.push({ o, c: await named(harness, `observer:${o.name}`, agentFor(o, extra, observeExt)) });
	}

	const inbox = at(cfg.inbox ?? `${cfg.runsDir}/inbox-${id}`);
	mkdirSync(`${inbox}/done`, { recursive: true });
	mkdirSync(`${inbox}/rejected`, { recursive: true });
	// The doer's internet. Every change is recorded with who made it and whether the internet was then reachable.
	let netState: "on" | "off" = "off";
	const switchNetwork = async (to: "on" | "off", source: string, step?: string) => {
		if (!cfg.sandbox?.net) throw new Fatal("network control needs sandbox.net (sandbox/net.sh)");
		const actual = setNetwork(to);
		const reachable = to === "on" ? (await probeInternet(workdir)) : false;
		netState = to;
		await write(`net:${Date.now()}`, "rer.network", { state: to, actual, reachable, source, step: step ?? null, at: new Date().toISOString() });
		setStatus({ network: to });
		console.log(`  internet ${to} (${source}${step ? `, before ${step}` : ""}; route ${actual}, reachable ${reachable})`);
		notify(`${id}: internet ${to} (${source})`);
	};
	const announcement = (to: "on" | "off") => (net.announce?.[to] ? pick(net.announce[to]!) : undefined);
	{
		// Resume where the record says the internet was; a fresh run starts as configured.
		const last = [...(await entries(doer))].reverse().find((e) => e.kind === "rer.network");
		const restore = (last?.data as any)?.state ?? net.start ?? "off";
		if (restore === "on" || usesNet) await switchNetwork(restore, last ? "resume" : "start");
	}

	// Inbox: files in the inbox go to the doer; files in inbox/observer-<name>/ go to that observer.
	const isFile = (p: string) => statSync(p).isFile();
	const pending = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => !f.startsWith(".") && isFile(join(dir, f))).sort() : []);
	const obsDir = (name: string) => join(inbox, `observer-${name}`);
	for (const { o } of observers) mkdirSync(obsDir(o.name), { recursive: true });
	const pollInbox = async () => {
		for (const f of pending(inbox)) {
			const raw = readFileSync(join(inbox, f), "utf8").trim();
			const n = raw.match(/^@net\s+(on|off)\b/);
			if (n) {
				const to = n[1] as "on" | "off";
				if (!cfg.sandbox?.net) {
					renameSync(join(inbox, f), join(inbox, "rejected", f));
					console.error(`  ${f}: no sandbox.net configured, cannot switch the internet`);
					continue;
				}
				// A person chose the timing, so it is an intervention; the announcement text itself is frozen.
				await switchNetwork(to, "human");
				const text = announcement(to);
				const data = { type: "network", state: to, file: f, announced: !!text };
				if (text) await doer.submit({ type: "input", content: text, whenBusy: "steer", requestId: `int:${f}`, entry: { kind: "rer.intervention", data } } as any, ctx);
				else await write(`int:${f}`, "rer.intervention", data);
				renameSync(join(inbox, f), join(inbox, "done", f));
				continue;
			}
			const m = raw.match(/^@push\s+(\S+)/);
			if (m && !pushes[m[1]]) {
				renameSync(join(inbox, f), join(inbox, "rejected", f));
				console.error(`  löyly rejected: ${f} names unknown push "${m[1]}"`);
				continue;
			}
			const type = m ? "menu" : "free";
			if (type === "free") await write(`contaminated:${f}`, "rer.contaminated", { file: f, at: new Date().toISOString() });
			await doer.submit({ type: "input", content: m ? pushes[m[1]] : raw, whenBusy: "steer", requestId: `int:${f}`, entry: { kind: "rer.intervention", data: { type, file: f, push: m?.[1] ?? null } } } as any, ctx);
			renameSync(join(inbox, f), join(inbox, "done", f));
			console.log(`  löyly (${type}) delivered: ${f}`);
			notify(`intervention (${type}) delivered in ${id}`);
		}
		// Talking to an observer never reaches the doer. A message to a blind observer may break its blindness, so it is marked.
		for (const { o, c } of observers)
			for (const f of pending(obsDir(o.name))) {
				const raw = readFileSync(join(obsDir(o.name), f), "utf8").trim();
				if (!o.informed) await c.submit({ type: "write", requestId: `human:${f}`, entry: { kind: "rer.human-contact", data: { file: f, at: new Date().toISOString() } } } as any, ctx);
				await c.submit({ type: "input", content: raw, whenBusy: "steer", requestId: `int:${f}`, entry: { kind: "rer.intervention", data: { type: "observer", file: f } } } as any, ctx);
				renameSync(join(obsDir(o.name), f), join(inbox, "done", `observer-${o.name}-${f}`));
				console.log(`  message to observer ${o.name} delivered: ${f}`);
			}
	};
	/** From the live page: the same as dropping a file into the inbox, so both paths are recorded identically. */
	const say = (to: string, message: string) => {
		const dir = to === "doer" ? inbox : observers.some(({ o }) => `observer:${o.name}` === to) ? obsDir(to.slice(9)) : undefined;
		if (!dir || !message.trim()) return false;
		writeFileSync(join(dir, `${Date.now()}-live.txt`), message.trim() + "\n");
		return true;
	};
	const budget = async () => {
		const spent = await costUsd(harness);
		const tokens = await tokensUsed(harness);
		setStatus({ usd: Number(spent.toFixed(4)), tokens });
		const over = cfg.budget?.maxUsd && spent >= cfg.budget.maxUsd ? `$${spent.toFixed(2)} of $${cfg.budget.maxUsd}`
			: cfg.budget?.maxTokens && tokens >= cfg.budget.maxTokens ? `${tokens} of ${cfg.budget.maxTokens} tokens` : undefined;
		if (over) {
			await doer.abort(ctx);
			throw new BudgetReached(`budget reached (${over})`);
		}
	};
	const stopLive = startLive(harness, { doer, ...Object.fromEntries(observers.map(({ o, c }) => [`observer:${o.name}`, c])) }, say);
	console.log(`run ${id}: ${plan.length} steps\ndrop a .txt into ${inbox} to intervene ("@push <id>" for a menu push, anything else is free and marks the run); observers: ${inbox}/observer-<name>/`);
	notify(`run ${id} started`);

	let ending = "completed";
	try {
		for (const [i, step] of plan.entries()) {
			console.log(`step ${i + 1}/${plan.length} (${step.key})`);
			setStatus({ phase: "doer", step: i + 1, of: plan.length, key: step.key });
			await budget();
			await pollInbox(); // also between steps, not only while the doer is busy
			const scheduled = net.schedule?.[step.key];
			let text = step.text;
			if (scheduled && scheduled !== netState) {
				await switchNetwork(scheduled, "schedule", step.key);
				const said = announcement(scheduled);
				if (said) text = `${said}\n\n${step.text}`;
			}
			await ask(doer, step.key, text, step.entry ? { entry: step.entry } : {}, async () => (await pollInbox(), await budget()));
			for (const [j, pid] of (cfg.autoPushes ?? []).entries())
				await ask(doer, `${step.key}:push${j}`, pick(pid), { entry: { kind: "rer.push", data: { id: pid, auto: true } } }, async () => (await pollInbox(), await budget()));
			await write(`mark:${step.key}`, "rer.step", { key: step.key, index: i });

			// Observers read what the doer did in this step. Nothing flows back to the doer.
			setStatus({ phase: "observers" });
			const all = await entries(doer);
			const mark = (key?: string) => all.findIndex((e) => e.kind === "rer.step" && (e.data as any)?.key === key);
			const digest = capTotal(render(all.slice(i ? mark(plan[i - 1].key) + 1 : 0, mark(step.key))));
			const said: { name: string; informed: boolean; text: string }[] = [];
			for (let round = 0; round < (cfg.observerRounds ?? 1); round++)
				for (const { o, c } of observers) {
					const heard = said.filter((s) => o.informed || cfg.blindSeesInformed || !s.informed);
					const discussion = heard.length ? `\n\nDiscussion so far:${heard.map((s) => `\n\n${s.name}: ${s.text}`).join("")}` : "";
					said.push({ name: o.name, informed: !!o.informed, text: await ask(c, `obs:${step.key}:${round}`, fill(T.observerStep, { step: i + 1, digest, discussion }), {}, pollInbox) });
				}
			notify(`${id}: step ${i + 1}/${plan.length} done`);
		}
	} catch (e) {
		if (!(e instanceof BudgetReached)) throw e;
		ending = e.message;
		console.log(ending);
	} finally {
		stopLive();
	}
	const usd = await costUsd(harness);
	await write(`done:${ending === "completed" ? "ok" : "budget"}`, "rer.done", { at: new Date().toISOString(), usd, ending });
	writeFileSync(doneFile, JSON.stringify({ id, ending, usd, at: new Date().toISOString() }, null, 2) + "\n");
	setStatus({ phase: "run done", ending });
	notify(`run ${id} ${ending}, $${usd.toFixed(2)}`);
	console.log(`done (${ending}). $${usd.toFixed(2)} spent.`);
	await close(harness);
}

async function exportRun(arm: string, runNo: string) {
	const { id, db, exportDir } = runId(arm, runNo);
	if (!existsSync(db)) throw new Fatal(`no run ${id} at ${db}`);
	const { harness } = await open(db);
	mkdirSync(exportDir, { recursive: true });
	const dump = async (name: string) => {
		const c = await lookup(harness, name);
		if (!c) return;
		const md = (await entries(c)).flatMap((e) => {
			if (!e.model) return [`> **${e.kind}** \`${JSON.stringify(e.data)}\``];
			const body = render([e], { includeThinking: true, maxToolChars: 0, user: "**→**" });
			return body ? [`_${e.kind}_\n\n${body}`] : [];
		});
		writeFileSync(`${exportDir}/${name.replace(/:/g, "-")}.md`, md.join("\n\n---\n\n") + "\n");
	};
	await dump("doer");
	for (const o of cfg.observers ?? []) await dump(`observer:${o.name}`);
	writeFileSync(`${exportDir}/usage.json`, JSON.stringify(await harness.usage(ctx), null, 2));
	console.log(`exported to ${exportDir} (raw: ${db})`);
	await close(harness);
}

// ---------- autonomous mode ----------

/** The whole study in one process: guessers per arm, then every run of every arm, alternating arm order so time of day
 *  and provider drift do not line up with one arm. Finished pieces leave a file and are skipped on restart. */
async function autoWorker() {
	const a = cfg.auto ?? {};
	const arms = a.arms ?? Object.keys(cfg.arms);
	const frozen = checkFrozen();
	if (!frozen.frozen && !flag("unfrozen") && !faux) throw new Fatal(`study files changed since freeze: ${frozen.diff.join(", ")}`);
	if ((a.guess ?? true) && cfg.guessers) for (const arm of arms) if (!existsSync(guessFile(arm))) await guess(arm);
	for (let r = 1; r <= (a.runs ?? 1); r++)
		for (const arm of r % 2 ? arms : [...arms].reverse()) {
			const { id, doneFile, exportDir } = runId(arm, String(r));
			if (!existsSync(doneFile)) await run(arm, String(r));
			if (!existsSync(join(exportDir, "doer.md"))) await exportRun(arm, String(r));
			console.log(`${id}: finished`);
		}
	setStatus({ phase: "study complete" });
	notify("study complete");
}

/** Keeps the worker going: restarts it after a crash with growing backoff, stops on a fatal error or Ctrl-C. */
async function supervise() {
	const max = cfg.auto?.maxRestarts ?? 50;
	for (let restarts = 0; ; restarts++) {
		const code = await new Promise<number>((done) => {
			const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1), "--worker"], { stdio: "inherit" });
			child.on("exit", (c, signal) => done(c ?? (signal === "SIGINT" ? 130 : 1))); // killed or crashed: restart
		});
		if (code === 0) return;
		if (code === 3 || code === 130 || code === 2) {
			setStatus({ phase: code === 3 ? "stopped: fatal error" : "stopped" });
			if (code === 3) notify("stopped on a fatal error; see the log");
			process.exit(code);
		}
		if (restarts >= max) {
			notify(`gave up after ${max} restarts`);
			process.exit(1);
		}
		const wait = Math.min(30 * 60_000, 15_000 * 2 ** Math.min(restarts, 7));
		setStatus({ phase: "restarting", restarts: restarts + 1, nextStartAt: new Date(Date.now() + wait).toISOString() });
		notify(`worker crashed (exit ${code}); restart ${restarts + 1} in ${Math.round(wait / 1000)} s`);
		await sleep(wait);
	}
}

/** Which models exist and which have credentials: every model the config uses, then a provider's catalog (--provider). */
async function listModels() {
	const used = [cfg.doer, cfg.designer, ...(cfg.observers ?? [])].filter(Boolean).map((r) => r!.model).concat(cfg.guessers?.models ?? []);
	const authed = new Map<string, boolean>();
	const hasAuth = async (p: string) => {
		if (!authed.has(p)) authed.set(p, !!(await models.getAuth(p).catch(() => undefined)));
		return authed.get(p)!;
	};
	console.log("models in this config:");
	for (const m of [...new Set(used)]) {
		const i = m.indexOf("/");
		const found = models.getModel(m.slice(0, i), m.slice(i + 1));
		console.log(`  ${found ? "ok     " : "UNKNOWN"} ${(await hasAuth(m.slice(0, i))) ? "key ok " : "NO KEY "} ${m}`);
	}
	const provider = opt("provider", "");
	if (provider) {
		console.log(`\n${provider} catalog (${(await hasAuth(provider)) ? "credentials found" : "no credentials"}):`);
		for (const m of models.getModels(provider)) {
			const c: any = (m as any).cost ?? {};
			console.log(`  ${provider}/${m.id}  ctx ${(m as any).contextWindow ?? "?"}  $${c.input ?? "?"}/$${c.output ?? "?"} per Mtok${(m as any).reasoning ? "  reasoning" : ""}`);
		}
	}
}

const commands: Record<string, () => unknown> = {
	models: listModels,
	auto: () => (flag("worker") ? autoWorker() : supervise()),
	design,
	freeze,
	guess: () => guess(opt("arm", Object.keys(cfg.arms)[0])),
	run: () => run(opt("arm", Object.keys(cfg.arms)[0]), opt("run", "1")),
	export: () => exportRun(opt("arm", Object.keys(cfg.arms)[0]), opt("run", "1")),
};
if (!commands[command]) {
	console.error(`unknown command ${command}`);
	process.exit(2);
}
try {
	await commands[command]();
	process.exit(0);
} catch (e) {
	console.error(`error: ${(e as Error).message}`);
	setStatus({ phase: "error", error: (e as Error).message });
	process.exit(e instanceof Fatal ? 3 : 1);
}
