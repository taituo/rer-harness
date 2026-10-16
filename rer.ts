// RER harness: Reverse Eureka Reconstruction on Pi Durable.
//
//   node rer.ts auto           <config>   the whole study, unattended: guess, every arm × run, export; restarts on crashes
//   node rer.ts design         <config> [--arm X] [--blind]   draft a question path from the arm's target (or, blind, from domain)
//   node rer.ts freeze         <config>   hash every study file and the analysis plan (commit the freeze file)
//   node rer.ts guess          <config> [--arm X]   leakage test: tool-less guessers see questions 1..k
//   node rer.ts score-guesses  <config>   blind scorers rate every guess against the target; leakage curve per arm
//   node rer.ts run            <config> [--arm X] [--run N]   one run: doer walks the path, observers follow
//   node rer.ts export         <config> [--arm X] [--run N]   transcripts, idea ledger, file tree, summary
//   node rer.ts evaluate       <config>   frozen hidden acceptance tests against each finished run's work, objectively
//   node rer.ts judge          <config> [--unblind]   blind judges score anonymized final outputs; --unblind joins the key
//   node rer.ts import-pilot   <config> <file> [--arm X]   keep a pilot transcript as run 0, excluded from analysis
//   node rer.ts models         <config> [--provider P]   which models exist and have credentials
//
// Flags: --faux (offline dry run with fake models), --unfrozen (allow edits after freeze; recorded),
//        --allow-leaks (run even if the isolation canary fails; recorded).
//
// Everything study-specific lives in the config and the files it points to. Nothing a model reads is in this file,
// except the short framing templates in T, which the config can replace.

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { calculateCost } from "@earendil-works/pi-ai/models";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { configure, createRegistry, defineDoc, defineExtension, defineTool, GenerationTask, Harness, hook, ToolTask, watchEvents } from "@earendil-works/pi-durable";
import type { Conversation, EntryRecord, Submission } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";

const ctx = BACKGROUND_CONTEXT;
const here = dirname(new URL(import.meta.url).pathname);

/** Stops the study: a rerun cannot fix it (not frozen, not isolated, config mismatch). Exit code 3. */
class Fatal extends Error {}
/** Ends one run early but properly: recorded, exported, and the study goes on. */
class RunEnded extends Error {}
/** The doer went quiet for stallMinutes; thrown from the poll loop after the stall is recorded and the turn aborted. */
class Stall extends Error {}

// ---------- config ----------

type Role = { model: string; thinking?: string; instructions?: string };
/** start: state at the first step. schedule: step key -> state before that step (q1…, open1…). announce: push ids sent
 *  to the doer when its internet changes, so it is not left believing whatever doer.md said. */
type Network = { start?: "on" | "off"; schedule?: Record<string, "on" | "off">; announce?: { on?: string; off?: string } };
/** An arm is a step file, or a step file transformed: keep steps 1..cut, shuffle steps 2..n with a seed, pad to padTo
 *  steps with a frozen push so every arm gets the same number of turns, and optionally its own target. */
type ArmSpec = { file: string; cut?: number; shuffle?: string; padTo?: number; padPush?: string; target?: string };
type Config = {
	name: string;
	runsDir: string;
	arms: Record<string, string | ArmSpec>;
	pushes?: string; // push bank: "## id" sections
	autoPushes?: string[]; // push ids sent after every step, same for every arm
	afterPath?: string[]; // push ids sent as extra steps once the path ends (open phase)
	target?: string; // the known solution B: only the designer, informed observers, scorers and the informed judge see it
	domain?: string; // the area without the destination, for `design --blind`
	analysis?: string; // the analysis plan, frozen with everything else
	leakTerms?: string[]; // words that give the target away; redacted from judge packets and library answers
	targetPublishedAt?: string; // when B became public (YYYY-MM-DD); compared with knowledgeCutoffs
	knowledgeCutoffs?: Record<string, string>; // model -> training cutoff (YYYY-MM or YYYY-MM-DD)
	workdir: string; // base dir; each run gets a neutral subdirectory
	sandbox?: { start?: string; shell?: string; net?: string; container?: string; forbiddenPaths?: string[] };
	network?: Network; // the doer's internet: off unless this says otherwise
	networkByArm?: Record<string, Network>;
	doer: Role;
	observers?: (Role & { name: string; informed?: boolean })[];
	observerRounds?: number;
	observerTools?: boolean; // read-only access to the doer's transcript and files, plus the idea ledger (default true)
	blindSeesInformed?: boolean; // default false: blind observers never see what informed ones say
	designer?: Role & { blindInstructions?: string };
	guessers?: {
		models: string[]; thinking?: string; cutoffs: number[]; repeats: number; prompt: string; shuffled?: boolean;
		scorers?: string[]; scoreRubric?: string; leakThreshold?: number;
	};
	judge?: { blind: string[]; informed?: string; thinking?: string; rubric: string; distanceRubric?: string; resultFiles?: string[]; maxPacketChars?: number };
	/** Hidden acceptance tests: a command run on the host for each finished run, with RER_WORKDIR (the doer's work,
	 *  to be treated read-only), RER_EVAL_DIR (the frozen tests, never visible to the doer) and RER_OUT (write JSON
	 *  metrics there). It is not told the arm. sandbox/evaluate.sh runs the tests in a fresh offline container. */
	evaluator?: { command: string; dir?: string; timeoutMinutes?: number };
	library?: { model: string; thinking?: string; instructions?: string; search: string; before?: string; fromStep?: string; maxResults?: number; allowUndated?: boolean };
	budget?: { maxUsd?: number; maxTokens?: number; maxWallMinutes?: number; stallMinutes?: number; stallPush?: string }; // per run
	modelRetries?: number; // provider retries inside one model call (no new message to the model)
	retries?: number; // resubmissions after a call still failed; each is recorded
	inbox?: string;
	digest?: { maxToolChars?: number; maxChars?: number; includeThinking?: boolean };
	templates?: { observerStep?: string; informedTarget?: string; libraryQuestion?: string };
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
const positional = args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1]));
const [command, configArg] = positional;
if (!command || !configArg) {
	console.error("usage: node rer.ts <auto|design|freeze|guess|score-guesses|run|export|judge|import-pilot|models> <config.json> [--arm rer] [--run 1] [--faux]");
	process.exit(2);
}
const configPath = resolve(configArg);
const base = dirname(configPath);
const cfg: Config = JSON.parse(readFileSync(configPath, "utf8"));
const at = (p: string) => (isAbsolute(p) ? p : resolve(base, p));
const text = (p: string) => readFileSync(at(p), "utf8");
const stripComments = (s: string) => s.replace(/<!--[\s\S]*?-->/g, "");
const clean = (p: string) => stripComments(text(p)).trim();
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const csv = (rows: (string | number)[][]) => rows.map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))).join(",")).join("\n") + "\n";

/** Steps: blocks separated by a line containing only "---". HTML comments are author notes and never sent. */
function steps(file: string): string[] {
	return stripComments(text(file)).split(/^---\s*$/m).map((s) => s.trim()).filter(Boolean);
}
/** Push bank: "## id" headings, body until the next heading. */
const pushes: Record<string, string> = {};
if (cfg.pushes && existsSync(at(cfg.pushes)))
	for (const part of stripComments(text(cfg.pushes)).split(/^## +/m).slice(1)) {
		const nl = part.indexOf("\n");
		pushes[part.slice(0, nl).trim()] = part.slice(nl + 1).trim();
	}
function pick(pid: string) {
	if (!pushes[pid]) throw new Fatal(`push "${pid}" not in ${cfg.pushes}`);
	return pushes[pid];
}
const fill = (t: string, v: Record<string, string | number>) => t.replace(/\{(\w+)\}/g, (m, k) => (k in v ? String(v[k]) : m));
const T = {
	observerStep: "Step {step}, what the researcher did:\n\n{digest}{discussion}",
	informedTarget: "The work you are observing is heading, knowingly or not, toward this known result:\n\n{target}",
	libraryQuestion: "Question: {question}\n\nSources you may use (and only these):\n\n{sources}",
	...cfg.templates,
};
const instructions = (r: { instructions?: string }) => (r.instructions ? clean(r.instructions) || undefined : undefined);

// ---------- arms ----------

type Step = { key: string; text: string; entry?: { kind: string; data: object } };
function armSpec(arm: string): ArmSpec {
	const a = cfg.arms[arm];
	if (!a) throw new Fatal(`unknown arm ${arm}; config has ${Object.keys(cfg.arms).join(", ")}`);
	return typeof a === "string" ? { file: a } : a;
}
/** The path steps an arm sends, after cut, shuffle and padding; recorded in every run so it states what it received. */
function armSteps(arm: string): Step[] {
	const spec = armSpec(arm);
	let list: Omit<Step, "key">[] = steps(spec.file).map((t) => ({ text: t }));
	if (spec.cut) list = list.slice(0, spec.cut);
	if (spec.shuffle) list = [list[0], ...seededShuffle(list.slice(1), sha(spec.shuffle))].filter(Boolean);
	if (spec.padTo) {
		const id = spec.padPush ?? "continue";
		while (list.length < spec.padTo) list.push({ text: pick(id), entry: { kind: "rer.push", data: { id, pad: true } } });
	}
	return list.map((s, i) => ({ key: `q${i + 1}`, ...s }));
}
const armTarget = (arm: string) => armSpec(arm).target ?? cfg.target;
const targetText = (arm: string) => {
	const t = armTarget(arm);
	return t ? clean(t) : undefined;
};

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
const fauxId = (m: string) => m.replace(/[^a-zA-Z0-9.-]/g, "_");
const allModels = () =>
	[...new Set([cfg.doer, cfg.designer, ...(cfg.observers ?? [])].filter(Boolean).map((r) => r!.model)
		.concat(cfg.guessers?.models ?? [], cfg.guessers?.scorers ?? [], cfg.judge?.blind ?? [], cfg.judge?.informed ? [cfg.judge.informed] : [], cfg.library ? [cfg.library.model] : []))];
const models = builtinModels();
if (faux) {
	const usdPerMTok = Number(process.env.RER_FAUX_COST ?? 0); // faux-only: make budget limits testable
	// One fake model per configured model, so per-role usage and the model-mismatch guard behave as in a real run.
	const f = fauxProvider({ provider: "faux", models: allModels().map(fauxId).map((id) => ({ id, reasoning: true, cost: { input: usdPerMTok, output: usdPerMTok, cacheRead: 0, cacheWrite: 0 } })) as any, tokensPerSecond: Number(process.env.RER_FAUX_TPS ?? 0) || undefined });
	let n = 0;
	let scripted = 0; // the doer's scripted calls keep their own order, whatever the observers do
	const respond = (context: any) => {
		const msgs = context.messages ?? [];
		const last = msgs[msgs.length - 1];
		// faux-only: behave like a strict OpenAI endpoint and reject duplicate tool result ids
		const resultIds = msgs.filter((m: any) => m.role === "toolResult").map((m: any) => m.toolCallId);
		if (new Set(resultIds).size !== resultIds.length) console.error(`[faux] DUPLICATE tool result ids in request: ${resultIds.join(",")}`);
		const lastUser = [...msgs].reverse().find((m: any) => m.role === "user");
		const said = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
		const system = JSON.stringify(msgs.filter((m: any) => m.role === "system"));
		const tools: string[] = msgs.flatMap((m: any) => (m.role === "system" ? (m.toolsAdded ?? []).map((t: any) => t.name ?? t) : []));
		if (process.env.RER_FAUX_FAIL_OBSERVERS && tools.includes("transcript"))
			return fauxAssistantMessage([], { stopReason: "error", errorMessage: "400 Duplicate function_call_output (faux)" });
		if (tools.length && last?.role === "user") {
			// faux-only: RER_FAUX_TOOLS='[["bash",{...}],["read",{...}]]' plays these calls in order, to attack the sandbox
			const script = process.env.RER_FAUX_TOOLS ? (JSON.parse(process.env.RER_FAUX_TOOLS) as [string, any][]) : undefined;
			const observerCalls: [string, any][] = [["transcript", { count: 3 }], ["ledger", { idea: `idea ${n}`, origin: ["question", "doer", "prior-knowledge"][n % 3], evidence: "transcript #1", status: "claimed" }], ["files", {}], ["search", { pattern: "step" }]];
			const call: [string, any] = tools.includes("bash")
				? (script ? script[scripted++ % script.length] : ["bash", { command: `echo step ${++n} && pwd && ls` }])
				: tools.includes("transcript") ? observerCalls[n++ % observerCalls.length] : [tools[0], {}];
			// faux-only: RER_FAUX_DUP_IDS=1 makes observers emit two parallel calls sharing one id, as some models do
			if (process.env.RER_FAUX_DUP_IDS && !tools.includes("bash"))
				return fauxAssistantMessage([fauxToolCall("transcript", { count: 1 }, { id: `dup${n}` }), fauxToolCall("files", {}, { id: `dup${n}` })], { stopReason: "toolUse" });
			return fauxAssistantMessage(fauxToolCall(call[0], call[1]), { stopReason: "toolUse" });
		}
		// A role asked for JSON gets the template from its instructions back, numbers filled in, so scoring pipelines run.
		const template = system.match(/JSON:\s*(\{.*?\})/)?.[1]?.replace(/\\"/g, '"');
		if (template)
			try {
				const t = JSON.parse(template);
				for (const k of Object.keys(t)) t[k] = typeof t[k] === "number" ? (n++ % (Math.max(1, t[k]) + 1)) : "faux";
				return fauxAssistantMessage(fauxText(JSON.stringify(t)));
			} catch {}
		return fauxAssistantMessage(fauxText(`[faux] responding to: ${said.slice(0, 80).replace(/\s+/g, " ")}`));
	};
	f.appendResponses(Array.from({ length: 50000 }, () => respond));
	models.setProvider(f.provider);
}
const ref = (m: string) => {
	if (faux) return { provider: "faux", modelId: fauxId(m) };
	const i = m.indexOf("/");
	if (i < 0) throw new Fatal(`model "${m}" must be provider/modelId`);
	return { provider: m.slice(0, i), modelId: m.slice(i + 1) };
};

/** Fail before starting, not after retries: every model must exist and have credentials. Also warn when a model's
 *  training may already contain the target, because then "discovery" cannot be told apart from recall. */
async function preflight(roles: string[]) {
	const warnings = cutoffWarnings(roles);
	for (const w of warnings) console.warn(`warning: ${w}`);
	if (faux) return warnings;
	for (const m of new Set(roles)) {
		const { provider, modelId } = ref(m);
		if (!models.getModel(provider, modelId)) throw new Fatal(`unknown model ${m}`);
		if (!(await models.getAuth(provider).catch(() => undefined))) throw new Fatal(`no credentials for ${provider} (needed by ${m}); set its API key`);
	}
	return warnings;
}
function cutoffWarnings(roles: string[]) {
	const published = cfg.targetPublishedAt;
	if (!published) return [];
	return [...new Set(roles)].flatMap((m) => {
		const cutoff = cfg.knowledgeCutoffs?.[m];
		if (!cutoff) return [`${m} has no knowledgeCutoffs entry; cannot check whether it may know the target (published ${published})`];
		return cutoff >= published.slice(0, cutoff.length) ? [`${m} has training cutoff ${cutoff}, not before the target's publication ${published}: it may know the target`] : [];
	});
}

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

const forbidden = () => [base, here, ...(cfg.evaluator?.dir ? [at(cfg.evaluator.dir)] : []), ...(cfg.sandbox?.forbiddenPaths ?? []).map(at)];

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
	results["guard:symlink"] = within(workdir, `.rer-canary-link/${basename(configPath)}`) ? "leak" : "blocked";
	results["guard:parent"] = within(workdir, "../") ? "leak" : "blocked";
	spawnSync("rm", ["-f", link]);
	return { shellWorks, results, isolated: shellWorks && Object.values(results).every((v) => v === "blocked") };
}

// ---------- harness ----------

/** Some models give two parallel tool calls the same id. Pi then sends two results with that id, and strict
 *  OpenAI-compatible endpoints reject the request ("Duplicate function_call_output", issue #3). Before every request,
 *  give each repeated id a unique suffix in both the call and its matching result, in order. Only the request changes;
 *  the stored transcript keeps what the model produced. */
const UniqueToolIds = defineExtension({
	name: "rer.unique-tool-ids",
	hooks: [
		hook(GenerationTask, {
			beforeRequest: ({ messages }: any) => {
				const seen = new Map<string, number>();
				const pending = new Map<string, string[]>();
				let changed = false;
				const out = messages.map((m: any) => {
					if (m.role === "assistant" && Array.isArray(m.content)) {
						const content = m.content.map((b: any) => {
							if (b.type !== "toolCall") return b;
							const n = seen.get(b.id) ?? 0;
							seen.set(b.id, n + 1);
							const id = n ? `${b.id}__${n + 1}` : b.id;
							pending.set(b.id, [...(pending.get(b.id) ?? []), id]);
							if (id === b.id) return b;
							changed = true;
							return { ...b, id };
						});
						return content.some((b: any, i: number) => b !== m.content[i]) ? { ...m, content } : m;
					}
					if (m.role === "toolResult") {
						const queue = pending.get(m.toolCallId);
						const id = queue?.shift();
						return id && id !== m.toolCallId ? { ...m, toolCallId: id } : m;
					}
					return m;
				});
				return changed ? { messages: out } : undefined;
			},
		}),
	],
});

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
	registry.install(UniqueToolIds);
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
	extensions: ext ? [ext, UniqueToolIds] : [],
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
	throw new Error(`${requestId} still failed after ${(cfg.retries ?? 1) + 1} attempts`);
}

async function answerText(c: Conversation, entryId: string) {
	const page = await c.entries({ minEntryId: entryId as any, maxEntryId: entryId as any }, 1, undefined, ctx);
	return render([...page.items], { includeThinking: false, maxToolChars: 0 });
}

/** Ask for JSON and parse the first object in the answer; a model that will not produce one gets two more chances. */
async function askJson(c: Conversation, requestId: string, content: string): Promise<Record<string, unknown>> {
	for (let i = 0; i < 3; i++) {
		const answer = await ask(c, i ? `${requestId}~${i}` : requestId, i ? `${content}\n\nAnswer with the JSON object only.` : content);
		const m = answer.match(/\{[\s\S]*\}/);
		if (m)
			try {
				return JSON.parse(m[0]);
			} catch {}
	}
	return { error: "no JSON" };
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

// ---------- redaction ----------

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Replace every leak term (case-insensitive) and return how many were replaced, so redactions are logged. */
function redact(s: string, extra: string[] = []): { text: string; count: number } {
	let count = 0;
	let out = s;
	for (const term of [...(cfg.leakTerms ?? []), ...extra].filter(Boolean)) {
		out = out.replace(new RegExp(escapeRe(term), "gi"), () => (count++, "[redacted]"));
	}
	return { text: out, count };
}
const mentionsLeak = (s: string) => (cfg.leakTerms ?? []).some((t) => s.toLowerCase().includes(t.toLowerCase()));

// ---------- observer tools: read-only view of the doer's work, and the idea ledger ----------

let observingStep = ""; // the step the observers are currently discussing, stamped on ledger rows

function listFiles(dir: string, acc: string[] = []) {
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
}
function readable(p: string) {
	const st = statSync(p);
	if (st.size > 2_000_000) return undefined;
	const buf = readFileSync(p);
	return buf.subarray(0, 8000).includes(0) ? undefined : buf.toString("utf8");
}

function observeTools(getDoer: () => Promise<Conversation>, workdir: string) {
	const out = (t: string) => ({ output: [{ type: "text" as const, text: t }] });
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
			defineTool({
				name: "ledger",
				description: "Log one new idea in the shared idea ledger, once, when it first appears: where it came from (the question asked, the researcher itself, or prior knowledge the researcher brought in), the evidence (a transcript entry or file), and how far it got.",
				parameters: Type.Object({
					idea: Type.String(),
					origin: Type.Union([Type.Literal("question"), Type.Literal("doer"), Type.Literal("prior-knowledge")]),
					evidence: Type.String(),
					status: Type.Union([Type.Literal("claimed"), Type.Literal("tested"), Type.Literal("verified")]),
				}),
				execute: async (a: any, api: any) => {
					const row = { step: observingStep, idea: a.idea, origin: a.origin, evidence: a.evidence, status: a.status, at: new Date().toISOString() };
					await api.commit(async (tx: any) => tx.appendEntry(api.conversationId, { kind: "rer.ledger", data: row }), ctx);
					return out(`logged (${observingStep}): ${a.idea}`);
				},
			}),
		],
	});
}

// ---------- librarian: literature through a filter ----------

/** The doer's only way to the literature: a librarian model that sees nothing but search results from before
 *  `library.before`, with every result mentioning a leak term dropped, and whose answer is redacted again. */
function libraryTool(harness: Harness) {
	const lib = cfg.library!;
	return defineExtension({
		name: "rer.library",
		tools: [
			defineTool({
				name: "ask_librarian",
				description: "Ask the librarian a question about published literature. The librarian searches, reads, and answers with sources.",
				parameters: Type.Object({ question: Type.String() }),
				execute: async (a: any, api: any) => {
					const searched = spawnSync("sh", ["-c", lib.search], { env: { ...process.env, QUERY: a.question }, encoding: "utf8", timeout: 60_000 });
					let found: any[] = [];
					try {
						const parsed = JSON.parse(searched.stdout || "[]");
						found = Array.isArray(parsed) ? parsed : (parsed.results ?? []);
					} catch {
						found = [];
					}
					const dropped = { afterCutoff: 0, undated: 0, leakTerm: 0 };
					const kept = found.filter((r) => {
						const blob = `${r.title ?? ""} ${r.url ?? ""} ${r.snippet ?? ""} ${r.text ?? ""}`;
						if (mentionsLeak(blob)) return (dropped.leakTerm++, false);
						if (!r.date) return lib.allowUndated ? true : (dropped.undated++, false);
						if (lib.before && String(r.date) >= lib.before) return (dropped.afterCutoff++, false);
						return true;
					}).slice(0, lib.maxResults ?? 8);
					const sources = kept.map((r, i) => `[${i + 1}] ${r.title ?? "untitled"} (${r.date ?? "undated"}) ${r.url ?? ""}\n${(r.text ?? r.snippet ?? "").slice(0, 4000)}`).join("\n\n");
					let answer = "The library found no usable sources for this question.";
					if (kept.length) {
						const librarian = await named(harness, "librarian", agentFor({ model: lib.model, thinking: lib.thinking, instructions: lib.instructions }));
						answer = await ask(librarian, `lib:${api.callId}`, fill(T.libraryQuestion, { question: a.question, sources }));
					}
					const red = redact(answer);
					const listed = kept.map((r, i) => `[${i + 1}] ${r.title ?? "untitled"} (${r.date ?? "undated"}) ${r.url ?? ""}`).join("\n");
					await api.commit(async (tx: any) => tx.appendEntry(api.conversationId, { kind: "rer.library", data: { question: a.question, found: found.length, kept: kept.map((r) => ({ title: r.title, url: r.url, date: r.date })), dropped, redactions: red.count, searchExit: searched.status } }), ctx);
					return { output: [{ type: "text" as const, text: `${red.text}${listed ? `\n\nSources:\n${listed}` : ""}` }] };
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
	for (const arm of Object.keys(cfg.arms)) [armSpec(arm).file, armSpec(arm).target].forEach(add);
	[cfg.pushes, cfg.target, cfg.domain, cfg.analysis, cfg.doer.instructions, cfg.designer?.instructions, cfg.designer?.blindInstructions,
		cfg.guessers?.prompt, cfg.guessers?.scoreRubric, cfg.judge?.rubric, cfg.judge?.distanceRubric, cfg.library?.instructions].forEach(add);
	cfg.observers?.forEach((o) => add(o.instructions));
	if (cfg.evaluator?.dir && existsSync(at(cfg.evaluator.dir))) listFiles(at(cfg.evaluator.dir)).forEach((f) => files.add(f));
	for (const s of [cfg.sandbox?.shell, cfg.sandbox?.start, cfg.sandbox?.net]) {
		if (!s || !existsSync(at(s))) continue;
		const dir = dirname(at(s));
		for (const f of readdirSync(dir)) if (statSync(join(dir, f)).isFile()) files.add(join(dir, f)); // shell, start, net, Dockerfile
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
function requireFrozen() {
	const frozen = checkFrozen();
	if (!frozen.frozen && !flag("unfrozen") && !faux) throw new Fatal(`study files changed since freeze: ${frozen.diff.join(", ")} (refreeze, or pass --unfrozen to record it)`);
	return frozen;
}

// ---------- commands: preparation ----------

async function design() {
	const blind = flag("blind");
	if (!cfg.designer) throw new Fatal("config needs designer");
	const arm = opt("arm", "");
	const source = blind ? cfg.domain : arm ? armTarget(arm) : cfg.target;
	if (!source) throw new Fatal(blind ? "design --blind needs domain (the area, no destination)" : "config needs target");
	if (blind && !cfg.designer.blindInstructions) throw new Fatal("design --blind needs designer.blindInstructions");
	await preflight([cfg.designer.model]);
	const { harness } = await open(at(`${cfg.runsDir}/${cfg.name}-design${faux ? "-faux" : ""}.sqlite`));
	const role = blind ? { ...cfg.designer, instructions: cfg.designer.blindInstructions } : cfg.designer;
	const c = await named(harness, blind ? "designer-blind" : "designer", agentFor(role));
	const out = await ask(c, `design:${blind ? "blind:" : ""}${sha(text(source)).slice(0, 12)}`, clean(source));
	const file = at(`${cfg.runsDir}/questions${blind ? "-blind" : arm ? `-${arm}` : ""}.draft.md`);
	writeFileSync(file, out + "\n");
	console.log(`draft written to ${file}\nedit it, save it as an arm's step file, then: node rer.ts freeze ${configArg}`);
	await close(harness);
}

function freeze() {
	if (!cfg.analysis) console.warn("warning: no analysis plan (config.analysis); write one before freezing, or the metrics stay open after the results are in");
	const record = { frozenAt: new Date().toISOString(), versions: versions(), analysis: cfg.analysis ?? null, files: fingerprint() };
	writeFileSync(freezeFile(), JSON.stringify(record, null, 2) + "\n");
	console.log(`froze ${Object.keys(record.files).length} files into ${relative(process.cwd(), freezeFile())}; commit it before running:`);
	for (const [f, h] of Object.entries(record.files)) console.log(`  ${h.slice(0, 12)}  ${f}`);
}

const guessFile = (arm: string) => at(`${cfg.runsDir}/${cfg.name}-${arm}-guesses${faux ? "-faux" : ""}.jsonl`);

async function guess(arm: string) {
	const g = cfg.guessers;
	if (!g) throw new Fatal("config needs guessers");
	await preflight(g.models);
	const qs = armSteps(arm).map((s) => s.text);
	const prompt = clean(g.prompt);
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
	console.log(`guesses in ${guessFile(arm)}; score them with: node rer.ts score-guesses ${configArg}`);
	await close(harness);
}

/** Scorers see the arm's target and one guess at a time: never the arm, the order, the cutoff, or the questions. Every
 *  guess of every arm is shuffled together; the mapping is a separate file. Writes the leakage curve per arm. */
async function scoreGuesses() {
	const g = cfg.guessers;
	if (!g?.scorers?.length || !g.scoreRubric) throw new Fatal("score-guesses needs guessers.scorers and guessers.scoreRubric");
	await preflight(g.scorers);
	const arms = (cfg.auto?.arms ?? Object.keys(cfg.arms)).filter((a) => existsSync(guessFile(a)));
	if (!arms.length) throw new Fatal("no guesses yet; run guess (or auto) first");
	const items = arms.flatMap((arm) => readFileSync(guessFile(arm), "utf8").trim().split("\n").map((l) => JSON.parse(l)))
		.map((x) => ({ ...x, id: sha(`${x.arm}|${x.order}|${x.model}|${x.k}|${x.repeat}`).slice(0, 12) }));
	const dir = at(`${cfg.runsDir}/${cfg.name}-leakage${faux ? "-faux" : ""}`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "key.json"), JSON.stringify(Object.fromEntries(items.map((x) => [x.id, { arm: x.arm, order: x.order, model: x.model, k: x.k, repeat: x.repeat }])), null, 2));
	const { harness } = await open(join(dir, "scoring.sqlite"));
	const rubric = clean(g.scoreRubric);
	const rows: (string | number)[][] = [["arm", "order", "k", "model", "repeat", "scorer", "score", "why"]];
	setStatus({ phase: "score-guesses" });
	for (const x of seededShuffle(items, sha(`${cfg.name}:score`)))
		for (const scorer of g.scorers) {
			const target = targetText(x.arm) ?? "";
			const c = await named(harness, `score:${scorer}:${x.id}`, agentFor({ model: scorer, thinking: g.thinking }, `${rubric}\n\nThe target:\n\n${target}`));
			const j = await askJson(c, `score:${x.id}`, `The guess:\n\n${x.answer}`);
			rows.push([x.arm, x.order, x.k, x.model, x.repeat, scorer, Number(j.score ?? NaN), String(j.why ?? j.error ?? "")]);
		}
	writeFileSync(join(dir, "leakage.csv"), csv(rows));

	// Curve: mean score per arm × order × k; leak point: first k with mean ≥ threshold; agreement between scorers.
	const data = rows.slice(1).map((r) => ({ arm: String(r[0]), order: String(r[1]), k: Number(r[2]), model: String(r[3]), repeat: Number(r[4]), scorer: String(r[5]), score: Number(r[6]) }));
	const threshold = g.leakThreshold ?? 1.5;
	const lines = [`# Leakage curve: ${cfg.name}`, "", `Mean score (0 unrelated, 1 same area, 2 identifies the target) per arm and cutoff k. Leak point: first k with mean ≥ ${threshold}.`, ""];
	const groups = [...new Set(data.map((d) => `${d.arm}|${d.order}`))].sort();
	const ks = [...new Set(data.map((d) => d.k))].sort((a, b) => a - b);
	lines.push(`| arm | order | ${ks.map((k) => `k=${k}`).join(" | ")} | leak point |`, `|---|---|${ks.map(() => "---").join("|")}|---|`);
	for (const gkey of groups) {
		const [arm, order] = gkey.split("|");
		const means = ks.map((k) => {
			const s = data.filter((d) => d.arm === arm && d.order === order && d.k === k && !Number.isNaN(d.score)).map((d) => d.score);
			return s.length ? s.reduce((a, b) => a + b, 0) / s.length : NaN;
		});
		const leak = ks.find((k, i) => means[i] >= threshold);
		lines.push(`| ${arm} | ${order} | ${means.map((m) => (Number.isNaN(m) ? "–" : m.toFixed(2))).join(" | ")} | ${leak ?? "none"} |`);
	}
	if (g.scorers.length >= 2) {
		const [a, b] = g.scorers;
		const byItem = (s: string) => new Map(data.filter((d) => d.scorer === s).map((d) => [`${d.arm}|${d.order}|${d.model}|${d.k}|${d.repeat}`, d.score]));
		const A = byItem(a), B = byItem(b);
		const pairs = [...A.keys()].filter((k) => B.has(k)).map((k) => [A.get(k)!, B.get(k)!]).filter(([x, y]) => !Number.isNaN(x) && !Number.isNaN(y));
		const agree = pairs.filter(([x, y]) => x === y).length / (pairs.length || 1);
		const cats = [0, 1, 2];
		const pe = cats.reduce((s, c) => s + (pairs.filter(([x]) => x === c).length / (pairs.length || 1)) * (pairs.filter(([, y]) => y === c).length / (pairs.length || 1)), 0);
		const kappa = pe === 1 ? 1 : (agree - pe) / (1 - pe);
		lines.push("", `Scorer agreement (${a} vs ${b}, ${pairs.length} guesses): ${(agree * 100).toFixed(0)}% exact, Cohen's κ = ${kappa.toFixed(2)}.`);
	}
	writeFileSync(join(dir, "leakage.md"), lines.join("\n") + "\n");
	console.log(lines.join("\n"));
	console.log(`\nwritten to ${dir}`);
	await close(harness);
}

// ---------- commands: running ----------

function runId(arm: string, run: string) {
	armSpec(arm);
	const id = `${cfg.name}-${arm}-${run}`;
	// Neutral directory name: nothing about the study, the arm, or the target reaches the doer through its cwd.
	const workdir = resolve(at(cfg.workdir), `p${sha(id).slice(0, 8)}`);
	const stem = at(`${cfg.runsDir}/${id}${faux ? "-faux" : ""}`);
	return { id, workdir, db: `${stem}.sqlite`, doneFile: `${stem}.done.json`, exportDir: stem };
}

async function run(arm: string, runNo: string) {
	const { id, workdir, db, doneFile } = runId(arm, runNo);
	// The sandbox mounts the workdir at the same path, so a workdir inside the study or harness directory would put
	// those paths inside the doer's view. Refuse it outright.
	for (const [what, dir] of [["study", base], ["harness", here]] as const)
		if (inside(dir, at(cfg.workdir))) throw new Fatal(`workdir ${at(cfg.workdir)} is inside the ${what} directory ${dir}; put it elsewhere (e.g. /srv/work)`);
	const frozen = requireFrozen();
	const warnings = await preflight([cfg.doer.model, ...(cfg.observers ?? []).map((o) => o.model), ...(cfg.library ? [cfg.library.model] : [])]);
	mkdirSync(workdir, { recursive: true });
	console.log(`workdir ${workdir}`);
	setStatus({ phase: "isolation", arm, run: runNo, id, step: undefined, of: undefined, key: undefined });
	if (cfg.sandbox?.start) {
		const started = spawnSync(at(cfg.sandbox.start), [workdir, cfg.sandbox.container ?? "rer-sandbox"], { stdio: "inherit" });
		if (started.status !== 0) throw new Error(`sandbox start failed (exit ${started.status})`);
	}
	if (cfg.sandbox?.net) setNetwork("off"); // isolation is always checked with the internet off
	const iso = await canary(workdir);
	console.log(`isolation: shell ${iso.shellWorks ? "works" : "BROKEN"}, ${JSON.stringify(iso.results)}`);
	if (!iso.shellWorks) throw new Fatal("the doer's shell does not run in the workdir (is the sandbox container up? sandbox/start.sh <workdir>)");
	if (!iso.isolated && !flag("allow-leaks") && !faux) throw new Fatal("isolation canary failed; fix the sandbox or pass --allow-leaks to record it");

	const plan: Step[] = [
		...armSteps(arm),
		...(cfg.afterPath ?? []).map((pid, i) => ({ key: `open${i + 1}`, text: pick(pid), entry: { kind: "rer.push", data: { id: pid, phase: "open" } } })),
	];
	(cfg.autoPushes ?? []).forEach(pick);
	if (cfg.budget?.stallPush) pick(cfg.budget.stallPush);
	const net: Network = cfg.networkByArm?.[arm] ?? cfg.network ?? {};
	const usesNet = net.start === "on" || Object.values(net.schedule ?? {}).includes("on");
	const keys = plan.map((p) => p.key);
	for (const key of Object.keys(net.schedule ?? {})) if (!keys.includes(key)) throw new Fatal(`network.schedule names step "${key}", which this arm does not have (${keys.join(", ")})`);
	if (cfg.library?.fromStep && !keys.includes(cfg.library.fromStep)) throw new Fatal(`library.fromStep "${cfg.library.fromStep}" is not a step of this arm`);
	Object.values(net.announce ?? {}).forEach((pid) => pid && pick(pid));

	const { harness, registry } = await open(db);
	const guardExt = guard(workdir);
	registry.install(guardExt);
	const libraryExt = cfg.library ? libraryTool(harness) : undefined;
	if (libraryExt) registry.install(libraryExt);
	const doer = await named(harness, "doer", {
		model: ref(cfg.doer.model),
		thinkingLevel: (cfg.doer.thinking ?? "xhigh") as any,
		extensions: [CodingTools, guardExt, UniqueToolIds, ...(libraryExt && !cfg.library!.fromStep ? [libraryExt] : [])],
		instructions: instructions(cfg.doer),
		cwd: workdir,
	});
	const write = (requestId: string, kind: string, data: object) => doer.submit({ type: "write", requestId, entry: { kind, data } } as any, ctx);
	const history = await entries(doer);
	const firstStart = Date.parse((history.find((e) => e.kind === "rer.session")?.data as any)?.startedAt ?? new Date().toISOString());
	await write(`meta:${Date.now()}`, "rer.session", {
		arm, run: runNo, startedAt: new Date().toISOString(), faux, frozen: frozen.frozen, frozenDiff: frozen.diff,
		isolation: iso, versions: versions(), files: fingerprint(), config: cfg, warnings,
		steps: plan.map((s) => ({ key: s.key, sha: sha(s.text).slice(0, 12), entry: s.entry?.kind ?? null })),
	});

	const observeExt = cfg.observerTools === false ? undefined : observeTools(async () => doer, workdir);
	if (observeExt) registry.install(observeExt);
	// Blind observers speak first, so informed ones can respond to them without blind ones ever hearing the target.
	const ordered = [...(cfg.observers ?? [])].sort((a, b) => Number(!!a.informed) - Number(!!b.informed));
	const observers = [];
	for (const o of ordered) {
		const target = targetText(arm);
		const extra = o.informed && target ? fill(T.informedTarget, { target }) : undefined;
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
		const last = [...history].reverse().find((e) => e.kind === "rer.network");
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
				const said = announcement(to);
				const data = { type: "network", state: to, file: f, announced: !!said };
				if (said) await doer.submit({ type: "input", content: said, whenBusy: "steer", requestId: `int:${f}`, entry: { kind: "rer.intervention", data } } as any, ctx);
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

	// Limits. Activity is any event from the doer's conversation (streamed thinking, text, tool output), so a long
	// computation that prints or a model that thinks is not a stall; a silent hung command is.
	let lastActivity = Date.now();
	let lastEvent = "start";
	let turn = { step: "", rid: "" };
	const activity = await watchEvents(harness, doer.id, ctx);
	activity.start(async (events) => {
		lastActivity = Date.now();
		lastEvent = events[events.length - 1]?.type ?? lastEvent;
	});
	const limits = async () => {
		const spent = await costUsd(harness);
		const tokens = await tokensUsed(harness);
		const minutes = (Date.now() - firstStart) / 60_000;
		setStatus({ usd: Number(spent.toFixed(4)), tokens, minutes: Math.round(minutes) });
		const b = cfg.budget ?? {};
		const over = b.maxUsd && spent >= b.maxUsd ? `$${spent.toFixed(2)} of $${b.maxUsd}`
			: b.maxTokens && tokens >= b.maxTokens ? `${tokens} of ${b.maxTokens} tokens`
			: b.maxWallMinutes && minutes >= b.maxWallMinutes ? `wall clock, ${minutes.toFixed(1)} of ${b.maxWallMinutes} min` : undefined;
		if (over) {
			await doer.abort(ctx);
			throw new RunEnded(`budget reached (${over})`);
		}
		const quiet = (Date.now() - lastActivity) / 60_000;
		if (b.stallMinutes && turn.rid && quiet >= b.stallMinutes) {
			await write(`stall:${turn.rid}`, "rer.stall", { step: turn.step, rid: turn.rid, minutes: Number(quiet.toFixed(1)), lastEvent, at: new Date().toISOString() });
			console.log(`  stalled in ${turn.step}: no activity for ${quiet.toFixed(1)} min`);
			notify(`${id}: stalled in ${turn.step}`);
			await doer.abort(ctx);
			throw new Stall();
		}
	};
	const during = async () => (await pollInbox(), await limits());
	const stallsIn = async (step: string) => (await entries(doer)).filter((e) => e.kind === "rer.stall" && (e.data as any)?.step === step);

	/** One doer turn within a step. A stall aborts it and sends the frozen stall push once, as the same automatic,
	 *  arm-invariant intervention in every arm; a second stall in the same step ends the run as "stalled". */
	const doerAsk = async (step: string, rid: string, content: string, extra: object) => {
		turn = { step, rid };
		lastActivity = Date.now();
		if (!(await stallsIn(step)).some((s) => (s.data as any).rid === rid)) {
			try {
				await ask(doer, rid, content, extra, during);
				return;
			} catch (e) {
				if (!(e instanceof Stall)) throw e;
			}
		}
		const push = cfg.budget?.stallPush;
		if (!push || (await stallsIn(step)).length >= 2) throw new RunEnded(`stalled in ${step}`);
		turn = { step, rid: `${rid}:stall` };
		lastActivity = Date.now();
		try {
			await ask(doer, `${rid}:stall`, pick(push), { entry: { kind: "rer.push", data: { id: push, auto: true, reason: "stall" } } }, during);
		} catch (e) {
			if (e instanceof Stall) throw new RunEnded(`stalled in ${step}`);
			throw e;
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
			turn = { step: step.key, rid: "" };
			await limits();
			await pollInbox(); // also between steps, not only while the doer is busy
			if (libraryExt && cfg.library!.fromStep === step.key && !(await doer.agent(ctx)).extensions.some((x: any) => x.name === "rer.library")) {
				await doer.configure({ extensions: { add: [libraryExt] } } as any, ctx);
				await write(`library-open:${step.key}`, "rer.library-open", { step: step.key, at: new Date().toISOString() });
				console.log(`  library open from ${step.key}`);
			}
			const scheduled = net.schedule?.[step.key];
			let content = step.text;
			if (scheduled && scheduled !== netState) {
				await switchNetwork(scheduled, "schedule", step.key);
				const said = announcement(scheduled);
				if (said) content = `${said}\n\n${step.text}`;
			}
			await doerAsk(step.key, step.key, content, step.entry ? { entry: step.entry } : {});
			for (const [j, pid] of (cfg.autoPushes ?? []).entries())
				await doerAsk(step.key, `${step.key}:push${j}`, pick(pid), { entry: { kind: "rer.push", data: { id: pid, auto: true } } });
			turn = { step: step.key, rid: "" };
			await write(`mark:${step.key}`, "rer.step", { key: step.key, index: i });

			// Observers read what the doer did in this step. Nothing flows back to the doer.
			setStatus({ phase: "observers" });
			observingStep = step.key;
			const all = await entries(doer);
			const mark = (key?: string) => all.findIndex((e) => e.kind === "rer.step" && (e.data as any)?.key === key);
			const digest = capTotal(render(all.slice(i ? mark(plan[i - 1].key) + 1 : 0, mark(step.key))));
			const said: { name: string; informed: boolean; text: string }[] = [];
			for (let round = 0; round < (cfg.observerRounds ?? 1); round++)
				for (const { o, c } of observers) {
					const heard = said.filter((s) => o.informed || cfg.blindSeesInformed || !s.informed);
					const discussion = heard.length ? `\n\nDiscussion so far:${heard.map((s) => `\n\n${s.name}: ${s.text}`).join("")}` : "";
					// An observer is a witness, not part of the experiment: if it fails after its retries, record that and go on.
					let text: string;
					try {
						text = await ask(c, `obs:${step.key}:${round}`, fill(T.observerStep, { step: i + 1, digest, discussion }), {}, pollInbox);
					} catch (e) {
						if (e instanceof Fatal || e instanceof RunEnded) throw e;
						text = "(no comment: this observer failed at this step)";
						await write(`observer-failed:${o.name}:${step.key}:${round}`, "rer.observer-failed", { observer: o.name, step: step.key, round, error: (e as Error).message, at: new Date().toISOString() });
						console.error(`  observer ${o.name} failed at ${step.key}: ${(e as Error).message}`);
						notify(`${id}: observer ${o.name} failed at ${step.key}`);
					}
					said.push({ name: o.name, informed: !!o.informed, text });
				}
			notify(`${id}: step ${i + 1}/${plan.length} done`);
		}
	} catch (e) {
		if (!(e instanceof RunEnded)) throw e;
		ending = e.message;
		console.log(ending);
	} finally {
		stopLive();
		await activity.stop().catch(() => {});
	}
	const usd = await costUsd(harness);
	const kind = ending === "completed" ? "ok" : ending.startsWith("stalled") ? "stalled" : "budget";
	await write(`done:${kind}`, "rer.done", { at: new Date().toISOString(), usd, ending });
	writeFileSync(doneFile, JSON.stringify({ id, arm, run: runNo, ending, usd, at: new Date().toISOString() }, null, 2) + "\n");
	setStatus({ phase: "run done", ending });
	notify(`run ${id} ${ending}, $${usd.toFixed(2)}`);
	console.log(`done (${ending}). $${usd.toFixed(2)} spent.`);
	await close(harness);
}

// ---------- commands: after a run ----------

async function exportRun(arm: string, runNo: string) {
	const { id, db, exportDir, workdir } = runId(arm, runNo);
	if (!existsSync(db)) throw new Fatal(`no run ${id} at ${db}`);
	const { harness } = await open(db);
	mkdirSync(exportDir, { recursive: true });
	const ledger: any[] = [];
	const dump = async (name: string) => {
		const c = await lookup(harness, name);
		if (!c) return [];
		const all = await entries(c);
		const md = all.flatMap((e) => {
			if (e.kind === "rer.pilot") return (writeFileSync(`${exportDir}/pilot.md`, String((e.data as any).content)), [`> **rer.pilot** \`${(e.data as any).file}\` (see pilot.md)`]);
			if (e.kind === "rer.ledger") ledger.push({ observer: name.replace("observer:", ""), ...(e.data as any) });
			if (!e.model) return [`> **${e.kind}** \`${JSON.stringify(e.data)}\``];
			const body = render([e], { includeThinking: true, maxToolChars: 0, user: "**→**" });
			return body ? [`_${e.kind}_\n\n${body}`] : [];
		});
		writeFileSync(`${exportDir}/${name.replace(/:/g, "-")}.md`, md.join("\n\n---\n\n") + "\n");
		return all;
	};
	const doerEntries = await dump("doer");
	for (const o of cfg.observers ?? []) await dump(`observer:${o.name}`);
	writeFileSync(`${exportDir}/usage.json`, JSON.stringify(await harness.usage(ctx), null, 2));

	// The workdir as it ended: every file with size and hash, so judges and readers can check cited files exist.
	const files = existsSync(workdir) ? listFiles(workdir).map((f) => ({ path: relative(workdir, f), size: statSync(f).size, sha256: sha(readFileSync(f)) })) : [];
	writeFileSync(`${exportDir}/files.json`, JSON.stringify(files, null, 2));

	// Idea ledger and the path release point: the first step from which ideas originating with the doer are the
	// majority of new ideas in every later step that has any.
	writeFileSync(`${exportDir}/ledger.csv`, csv([["observer", "step", "idea", "origin", "evidence", "status"], ...ledger.map((r) => [r.observer, r.step, r.idea, r.origin, r.evidence, r.status])]));
	const stepOrder = doerEntries.filter((e) => e.kind === "rer.step").map((e) => (e.data as any).key as string);
	const share = stepOrder.map((s) => {
		const rows = ledger.filter((r) => r.step === s);
		return { step: s, ideas: rows.length, doer: rows.length ? rows.filter((r) => r.origin === "doer").length / rows.length : null };
	});
	const release = share.find((x, i) => x.doer !== null && x.doer > 0.5 && share.slice(i).every((y) => y.doer === null || y.doer > 0.5))?.step ?? null;
	const kinds = (k: string) => doerEntries.filter((e) => e.kind === k);
	const summary = {
		id, arm, run: runNo,
		ending: (kinds("rer.done").pop()?.data as any)?.ending ?? "unfinished",
		pilot: kinds("rer.pilot").length > 0,
		contaminated: kinds("rer.contaminated").length > 0,
		interventions: kinds("rer.intervention").map((e) => (e.data as any).type),
		stalls: kinds("rer.stall").map((e) => (e.data as any).step),
		retries: kinds("rer.retry").length,
		observerFailures: kinds("rer.observer-failed").map((e) => `${(e.data as any).observer}@${(e.data as any).step}`),
		restarts: Math.max(0, kinds("rer.session").length - 1),
		network: kinds("rer.network").map((e) => ({ state: (e.data as any).state, source: (e.data as any).source, step: (e.data as any).step })),
		library: { questions: kinds("rer.library").length, opened: (kinds("rer.library-open")[0]?.data as any)?.step ?? null },
		warnings: (kinds("rer.session")[0]?.data as any)?.warnings ?? [],
		ledger: { ideas: ledger.length, byStep: share, releasePoint: release },
		usd: await costUsd(harness),
		tokens: await tokensUsed(harness),
	};
	writeFileSync(`${exportDir}/summary.json`, JSON.stringify(summary, null, 2) + "\n");
	console.log(`exported to ${exportDir} (raw: ${db})`);
	await close(harness);
}

/** Keep a pilot transcript in the record as run 0: same storage, marked rer.pilot, never judged or counted. */
async function importPilot() {
	const file = positional[2];
	if (!file || !existsSync(file)) throw new Fatal("usage: node rer.ts import-pilot <config> <transcript file> [--arm X]");
	const arm = opt("arm", Object.keys(cfg.arms)[0]);
	const { id, db, doneFile } = runId(arm, "0");
	const { harness } = await open(db);
	const doer = await named(harness, "doer", { model: ref(cfg.doer.model), thinkingLevel: (cfg.doer.thinking ?? "xhigh") as any, extensions: [], tools: [] });
	const content = readFileSync(file, "utf8");
	await doer.submit({ type: "write", requestId: "pilot", entry: { kind: "rer.pilot", data: { file: basename(file), sha256: sha(content), content, importedAt: new Date().toISOString() } } } as any, ctx);
	await doer.submit({ type: "write", requestId: "done:pilot", entry: { kind: "rer.done", data: { ending: "pilot" } } } as any, ctx);
	writeFileSync(doneFile, JSON.stringify({ id, arm, run: "0", ending: "pilot", at: new Date().toISOString() }, null, 2) + "\n");
	console.log(`pilot kept as ${id} (excluded from judging and analysis)`);
	await close(harness);
}

/** Objective evaluation: the frozen hidden tests run against every finished run's work. The evaluator gets the work
 *  and the tests, not the arm; results join the arm only here, in the report. */
async function evaluate() {
	const ev = cfg.evaluator;
	if (!ev) throw new Fatal("config needs evaluator");
	requireFrozen();
	const runs = readdirSync(at(cfg.runsDir)).filter((f) => f.endsWith(faux ? "-faux.done.json" : ".done.json") && (faux || !f.endsWith("-faux.done.json")))
		.map((f) => JSON.parse(readFileSync(join(at(cfg.runsDir), f), "utf8"))).filter((d) => d.run !== "0" && d.arm && cfg.arms[d.arm]);
	if (!runs.length) throw new Fatal("no finished runs to evaluate");
	const rows: (string | number)[][] = [["arm", "run", "metric", "value"]];
	setStatus({ phase: "evaluate" });
	for (const r of runs) {
		const { workdir, exportDir, id } = runId(r.arm, r.run);
		mkdirSync(exportDir, { recursive: true });
		const outFile = join(exportDir, "evaluation.json");
		const cached = existsSync(outFile) && !/"error"/.test(readFileSync(outFile, "utf8")); // only successes are kept
		if (!cached) {
			const res = spawnSync("sh", ["-c", ev.command], {
				env: { ...process.env, RER_WORKDIR: workdir, RER_EVAL_DIR: ev.dir ? at(ev.dir) : "", RER_OUT: outFile },
				encoding: "utf8", timeout: (ev.timeoutMinutes ?? 30) * 60_000, cwd: base,
			});
			if (res.status !== 0 || !existsSync(outFile)) writeFileSync(outFile, JSON.stringify({ error: `evaluator wrote no result (exit ${res.status})`, stderr: (res.stderr ?? "").slice(-2000) }, null, 2));
			console.log(`  evaluated ${id} (exit ${res.status})`);
		}
		let result: Record<string, unknown> = {};
		try {
			result = JSON.parse(readFileSync(outFile, "utf8"));
		} catch {
			result = { error: "evaluation.json is not JSON" };
		}
		for (const [k, v] of Object.entries(result)) rows.push([r.arm, r.run, k, typeof v === "object" ? JSON.stringify(v) : String(v)]);
	}
	const file = at(`${cfg.runsDir}/${cfg.name}-evaluation${faux ? "-faux" : ""}.csv`);
	writeFileSync(file, csv(rows));
	// Per arm: mean of every numeric metric over runs, with the range, so one good run does not read as a trend.
	const data = rows.slice(1).map(([arm, run, metric, value]) => ({ arm: String(arm), run: String(run), metric: String(metric), value: Number(value) })).filter((d) => !Number.isNaN(d.value));
	const arms = [...new Set(data.map((d) => d.arm))].sort();
	const metrics = [...new Set(data.map((d) => d.metric))].sort();
	const lines = [`# Objective evaluation: ${cfg.name}`, "", `| metric | ${arms.join(" | ")} |`, `|---|${arms.map(() => "---").join("|")}|`];
	for (const m of metrics)
		lines.push(`| ${m} | ${arms.map((a) => {
			const v = data.filter((d) => d.arm === a && d.metric === m).map((d) => d.value);
			return v.length ? `${(v.reduce((x, y) => x + y, 0) / v.length).toFixed(3)} (${Math.min(...v)}–${Math.max(...v)}, n=${v.length})` : "–";
		}).join(" | ")} |`);
	const failed = rows.slice(1).filter((r) => r[2] === "error").map((r) => `${r[0]}-${r[1]}`);
	if (failed.length) lines.push("", `Evaluator errors: ${failed.join(", ")}`);
	writeFileSync(file.replace(/\.csv$/, ".md"), lines.join("\n") + "\n");
	console.log(lines.join("\n"));
}

/** Blind judging. Packets hold the doer's final answer and its result files, never the questions or pushes, with
 *  leak terms and the workdir path redacted; labels are random and the key is a separate file. Blind judges score a
 *  fixed rubric; one informed judge scores only distance to the target. `--unblind` joins the key afterwards. */
async function judge() {
	const j = cfg.judge;
	if (!j) throw new Fatal("config needs judge");
	const dir = at(`${cfg.runsDir}/${cfg.name}-judge${faux ? "-faux" : ""}`);
	if (flag("unblind")) return unblind(dir);
	await preflight([...j.blind, ...(j.informed ? [j.informed] : [])]);
	const runs = readdirSync(at(cfg.runsDir)).filter((f) => f.endsWith(faux ? "-faux.done.json" : ".done.json") && (faux || !f.endsWith("-faux.done.json")))
		.map((f) => JSON.parse(readFileSync(join(at(cfg.runsDir), f), "utf8"))).filter((d) => d.run !== "0" && d.arm && cfg.arms[d.arm]);
	if (!runs.length) throw new Fatal("no finished runs to judge");
	mkdirSync(join(dir, "packets"), { recursive: true });
	const keyFile = join(dir, "key.json");
	const key: Record<string, { arm: string; run: string; redactions: number }> = existsSync(keyFile) ? JSON.parse(readFileSync(keyFile, "utf8")) : {};
	const known = new Set(Object.values(key).map((k) => `${k.arm}|${k.run}`));
	for (const r of runs) {
		if (known.has(`${r.arm}|${r.run}`)) continue;
		const label = `P-${randomBytes(3).toString("hex")}`;
		const { packet, redactions } = await buildPacket(r.arm, r.run);
		writeFileSync(join(dir, "packets", `${label}.md`), packet);
		key[label] = { arm: r.arm, run: r.run, redactions };
	}
	writeFileSync(keyFile, JSON.stringify(key, null, 2));
	const { harness } = await open(join(dir, "judging.sqlite"));
	const rubric = clean(j.rubric);
	const rows: (string | number)[][] = [["label", "judge", "role", "field", "value"]];
	setStatus({ phase: "judge" });
	// Random order, so no judge sees the arms in a pattern; the order is reproducible from the study name.
	for (const label of seededShuffle(Object.keys(key).sort(), sha(`${cfg.name}:judge`))) {
		const packet = readFileSync(join(dir, "packets", `${label}.md`), "utf8");
		for (const model of j.blind) {
			const c = await named(harness, `judge:${model}:${label}`, agentFor({ model, thinking: j.thinking }, rubric));
			const out = await askJson(c, `judge:${label}`, packet);
			for (const [f, v] of Object.entries(out)) rows.push([label, model, "blind", f, typeof v === "object" ? JSON.stringify(v) : String(v)]);
		}
		if (j.informed && j.distanceRubric) {
			const target = targetText(key[label].arm) ?? "";
			const c = await named(harness, `distance:${j.informed}:${label}`, agentFor({ model: j.informed, thinking: j.thinking }, `${clean(j.distanceRubric)}\n\nThe target:\n\n${target}`));
			const out = await askJson(c, `distance:${label}`, packet);
			for (const [f, v] of Object.entries(out)) rows.push([label, j.informed, "informed", f, typeof v === "object" ? JSON.stringify(v) : String(v)]);
		}
		console.log(`  judged ${label}`);
	}
	writeFileSync(join(dir, "judgements.csv"), csv(rows));
	console.log(`judgements in ${dir}/judgements.csv (labels only). Packets: ${dir}/packets/.
Spot-check a share of packets yourself into ${dir}/human.csv (label,field,value) before you run: node rer.ts judge ${configArg} --unblind`);
	await close(harness);
}

async function buildPacket(arm: string, runNo: string) {
	const j = cfg.judge!;
	const { db, workdir } = runId(arm, runNo);
	const { harness } = await open(db);
	const doer = await lookup(harness, "doer");
	const all = doer ? await entries(doer) : [];
	await close(harness);
	// The doer's last words: the final assistant entry with text.
	const final = [...all].reverse().find((e) => e.kind === "pi.assistant" && render([e], { maxToolChars: 0 }).trim());
	const finalText = final ? render([final], { includeThinking: false, maxToolChars: 0 }) : "(no final answer)";
	const files = existsSync(workdir) ? listFiles(workdir) : [];
	const patterns = (j.resultFiles ?? ["README*", "*result*", "*log*.md", "*.md"]).map((p) => new RegExp(`^${p.split("*").map(escapeRe).join(".*")}$`, "i"));
	const named_ = files.filter((f) => finalText.includes(basename(f)));
	const matched = files.filter((f) => !named_.includes(f) && patterns.some((re) => re.test(basename(f))));
	const max = j.maxPacketChars ?? 120_000;
	let body = `# Final report\n\n${finalText}\n\n# Project files\n\n${files.map((f) => relative(workdir, f)).join("\n") || "(none)"}\n`;
	for (const f of [...named_, ...matched]) {
		const t = readable(f);
		if (t === undefined || body.length > max) continue;
		body += `\n# File: ${relative(workdir, f)}\n\n${t.slice(0, 20_000)}${t.length > 20_000 ? "\n…[truncated]" : ""}\n`;
	}
	body = body.slice(0, max).split(workdir).join("<project>").replace(/\bp[0-9a-f]{8}\b/g, "<project>");
	const red = redact(body);
	return { packet: red.text, redactions: red.count };
}

function unblind(dir: string) {
	const key = JSON.parse(readFileSync(join(dir, "key.json"), "utf8"));
	const rows = readFileSync(join(dir, "judgements.csv"), "utf8").trim().split("\n").slice(1).map((l) => parseCsvLine(l));
	const data = rows.map(([label, judgeModel, role, field, value]) => ({ label, judge: judgeModel, role, field, value: Number(value), arm: key[label]?.arm, run: key[label]?.run })).filter((d) => !Number.isNaN(d.value));
	const fields = [...new Set(data.map((d) => `${d.role}|${d.field}`))].sort();
	const arms = [...new Set(data.map((d) => d.arm))].sort();
	const lines = [`# Blind judgements: ${cfg.name}`, "", "Mean per arm (min–max over runs, each run averaged over judges).", "", `| field | ${arms.join(" | ")} |`, `|---|${arms.map(() => "---").join("|")}|`];
	for (const fr of fields) {
		const [role, field] = fr.split("|");
		const cells = arms.map((arm) => {
			const perRun = [...new Set(data.filter((d) => d.arm === arm).map((d) => d.run))].map((run) => {
				const v = data.filter((d) => d.arm === arm && d.run === run && d.role === role && d.field === field).map((d) => d.value);
				return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
			}).filter((v) => !Number.isNaN(v));
			if (!perRun.length) return "–";
			const mean = perRun.reduce((a, b) => a + b, 0) / perRun.length;
			return `${mean.toFixed(2)} (${Math.min(...perRun).toFixed(1)}–${Math.max(...perRun).toFixed(1)}, n=${perRun.length})`;
		});
		lines.push(`| ${role === "informed" ? `${field} (informed)` : field} | ${cells.join(" | ")} |`);
	}
	// Agreement between blind judges, per field: exact agreement and mean absolute difference.
	const judges = [...new Set(data.filter((d) => d.role === "blind").map((d) => d.judge))];
	if (judges.length >= 2) {
		lines.push("", `Agreement between ${judges[0]} and ${judges[1]}:`, "");
		for (const field of [...new Set(data.filter((d) => d.role === "blind").map((d) => d.field))]) {
			const a = new Map(data.filter((d) => d.judge === judges[0] && d.field === field).map((d) => [d.label, d.value]));
			const pairs = data.filter((d) => d.judge === judges[1] && d.field === field && a.has(d.label)).map((d) => [a.get(d.label)!, d.value]);
			if (!pairs.length) continue;
			const exact = pairs.filter(([x, y]) => x === y).length / pairs.length;
			const mad = pairs.reduce((s, [x, y]) => s + Math.abs(x - y), 0) / pairs.length;
			lines.push(`- ${field}: ${(exact * 100).toFixed(0)}% exact, mean |difference| ${mad.toFixed(2)} (${pairs.length} packets)`);
		}
	}
	const humanFile = join(dir, "human.csv");
	if (existsSync(humanFile)) {
		const human = readFileSync(humanFile, "utf8").trim().split("\n").slice(1).map((l) => parseCsvLine(l)).map(([label, field, value]) => ({ label, field, value: Number(value) }));
		lines.push("", `Your spot-check (${new Set(human.map((h) => h.label)).size} packets) against each blind judge:`, "");
		for (const jm of judges) {
			const pairs = human.map((h) => [h.value, data.find((d) => d.judge === jm && d.label === h.label && d.field === h.field)?.value]).filter(([, v]) => v !== undefined) as number[][];
			if (pairs.length) lines.push(`- ${jm}: ${((pairs.filter(([x, y]) => x === y).length / pairs.length) * 100).toFixed(0)}% exact over ${pairs.length} scores`);
		}
	} else lines.push("", "No human spot-check found (human.csv); report that it was not done.");
	writeFileSync(join(dir, "summary.md"), lines.join("\n") + "\n");
	console.log(lines.join("\n"));
}
function parseCsvLine(line: string): string[] {
	const out: string[] = [];
	let cur = "", q = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (q) {
			if (ch === '"' && line[i + 1] === '"') (cur += '"'), i++;
			else if (ch === '"') q = false;
			else cur += ch;
		} else if (ch === '"') q = true;
		else if (ch === ",") out.push(cur), (cur = "");
		else cur += ch;
	}
	out.push(cur);
	return out;
}

// ---------- autonomous mode ----------

/** The whole study in one process: guessers per arm, then every run of every arm. Arm order follows a Latin square
 *  (each run index rotates the arm list by one), so time of day and provider drift do not line up with one arm.
 *  Finished pieces leave a file and are skipped on restart. */
async function autoWorker() {
	const a = cfg.auto ?? {};
	const arms = a.arms ?? Object.keys(cfg.arms);
	requireFrozen();
	if ((a.guess ?? true) && cfg.guessers) for (const arm of arms) if (!existsSync(guessFile(arm))) await guess(arm);
	for (let r = 1; r <= (a.runs ?? 1); r++) {
		const shift = (r - 1) % arms.length;
		for (const arm of [...arms.slice(shift), ...arms.slice(0, shift)]) {
			const { id, doneFile, exportDir } = runId(arm, String(r));
			if (!existsSync(doneFile)) await run(arm, String(r));
			if (!existsSync(join(exportDir, "summary.json"))) await exportRun(arm, String(r));
			console.log(`${id}: finished`);
		}
	}
	if (cfg.evaluator) await evaluate();
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
	const authed = new Map<string, boolean>();
	const hasAuth = async (p: string) => {
		if (!authed.has(p)) authed.set(p, !!(await models.getAuth(p).catch(() => undefined)));
		return authed.get(p)!;
	};
	console.log("models in this config:");
	for (const m of allModels()) {
		const i = m.indexOf("/");
		const found = models.getModel(m.slice(0, i), m.slice(i + 1));
		console.log(`  ${found ? "ok     " : "UNKNOWN"} ${(await hasAuth(m.slice(0, i))) ? "key ok " : "NO KEY "} ${m}`);
	}
	for (const w of cutoffWarnings(allModels())) console.log(`  warning: ${w}`);
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
	"score-guesses": scoreGuesses,
	run: () => run(opt("arm", Object.keys(cfg.arms)[0]), opt("run", "1")),
	export: () => exportRun(opt("arm", Object.keys(cfg.arms)[0]), opt("run", "1")),
	judge,
	"import-pilot": importPilot,
	evaluate,
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
