# Research targets: where B comes from, and how C is tested

From [issue #2](https://github.com/taituo/rer-harness/issues/2). The aim is a repeatable laboratory: many targets, each with a known mechanism B, a frozen question path, and **hidden, executable acceptance tests**, so a result C is judged on what it does rather than on how close it looks to B.

What the harness supports today:

- `node rer.ts evaluate`: runs frozen hidden tests against every finished run's work, in a fresh offline container, without telling the tests which arm it was.
- Everything else from [docs/study-design.md](study-design.md): arms, leakage scoring, blind judging.

What this page adds is the method: which targets, what to keep, and where the boundaries are.

## Three objects per target, kept apart

| Object | Contains | Who sees it |
|---|---|---|
| **B** (`target.md`) | the withheld mechanism, in a few sentences | designer, informed observer, scorers, informed judge |
| **Task contract** (`eval/`) | independent correctness and quality tests | only `evaluate`; never mounted for the doer |
| **Question path** (`questions.md`) | the only thing that reaches the researcher | doer |

Judge C on the contract, not on its similarity to B. An independent algorithm that passes, a justified impossibility result, or a useful departure can be a better outcome than an imitation.

## The evaluator contract

```json
"evaluator": { "command": "../sandbox/evaluate.sh", "dir": "eval", "timeoutMinutes": 30 }
```

`eval/run.sh` is called as `sh /eval/run.sh <copy of the work>` inside a fresh container with no network, and prints one JSON object of metrics. `sandbox/evaluate.sh` does the containment; set `RER_EVAL_IMAGE` for a different toolchain image.

- **Frozen.** The `eval/` directory is hashed by `freeze`, like the study files.
- **Hidden.** It is added to the doer's forbidden paths; every run's isolation check proves the doer cannot see it.
- **Arm-blind.** The evaluator gets only the work and the tests.

`auto` runs `evaluate` at the end of the study. Results go to `runs/<name>-evaluation.csv` and `.md` (mean, range and n per arm), and to each run's `evaluation.json`. Failed evaluations are recorded and retried on the next `evaluate`; only successes are cached.

Report deduplication, correctness, robustness and cost as separate metrics. Do not fold them into one score.

## Catalog of candidate targets

All of these are research targets, not established RER results. A good target has:

- an interesting mechanism,
- an executable oracle or mathematical invariants,
- robust hidden tests,
- room for more than one reasonable solution,
- safe offline execution.

**Algorithms and data structures: the best first targets.**

| Priority | B | Path seed (never naming B) | Hidden evidence |
|---|---|---|---|
| P0, pilot | Content-defined chunking (FastCDC) | How can overlapping parts of two files be recognized after bytes are inserted near the start? | exact reconstruction; deterministic boundaries; bytes reused after edits; chunk-size distribution; runtime, memory |
| P0 | HyperLogLog | How can a stream's number of distinct items be estimated without storing them? | error against cardinality and memory, skewed and adversarial streams |
| P0 | Time-series delta/XOR compression | Why do successive samples often need fewer bits than independent values? | decode(encode(x)) == x; ratio; throughput; NaN, -0.0, irregular timestamps |
| P1 | Minimal perfect hashing | Can a fixed key set be indexed without collisions or a dynamic table? | no collisions; bits per key; build time |
| P1 | Hamming-style error correction | Can a few redundant bits reveal *which* bit flipped? | exhaustive single-bit correction; multi-flip detection |
| P1 | Bloom / cuckoo filters | How can absent keys be rejected cheaply with bounded false positives? | no false negatives; measured false-positive rate |
| P1 | Succinct rank/select | How can bit-vector queries be fast without a large index? | exact oracle; bits per element; query speed |

**Systems** (simulated hardware only; never real devices or the host kernel):
- write-ahead log and atomic commit (crash after every write boundary),
- copy-on-write snapshots,
- LSM compaction,
- an interrupt-driven virtual device,
- deterministic replay,
- lease and lock protocols under clock skew.

**CI/CD and developer tools.** Test both safety (never a stale cache, never a skipped relevant test) and efficiency; a faster but incorrect system is not a success. Candidates:
- content-addressed build cache,
- flaky-test detection,
- dependency-based test selection,
- reproducible-build diagnosis,
- safe rollout and rollback,
- zero-downtime schema migration,
- minimal reproducers,
- regression bisection.

**Negative controls**, scored on recognizing the contradiction and offering useful restricted alternatives:
- exact multiplication by a ReLU network,
- universal lossless compression (impossible by the pigeonhole principle),
- storage guarantees that contradict a stated failure model.

See the impossible-target arm in [study-design.md](study-design.md).

## Preparation modes (an independent variable)

| Mode | The designer gets | Claim it supports |
|---|---|---|
| source-informed | pinned, documented open-source code | fastest; weakest "reverse engineering" claim |
| binary-informed | an executable built from pinned source, plus a behavioral oracle; source kept for audit only | the interesting second stage |
| behavior-only | a safe local oracle (inputs, outputs, resources) | how the quality of the inferred B affects the path |

The doer's boundary is identical in every mode. Compare modes within one target family and one budget, or the binary's difficulty becomes the explanation.

**Not in the harness yet: binary analysis.** Tools like Ghidra (headless), Rizin or radare2, REA, angr, Frida and AFL++ belong to the preparation step, in a separate container. They are never available to the doer unless a condition explicitly studies that. Start with source-informed targets; add binary-informed preparation as a separate script once a source-derived pilot works end to end.

Use only targets you may legally build and analyze. No proprietary unknown binaries, DRM, malware, third-party services or live systems.

## Target manifest

Keep one per target. It is documentation for now, not read by the harness.

```json
{
  "id": "fastcdc-mini",
  "area": "storage/deduplication",
  "source": { "url": "https://github.com/google/cdc-file-transfer", "commit": "<exact commit>" },
  "rights": { "licenseChecked": false, "notes": "verify reuse before publishing artifacts" },
  "preparationMode": "source",
  "binarySha256": null,
  "evaluator": "eval/",
  "contract": "eval/contract.md",
  "holdout": "eval/private-seeds.json",
  "budget": { "maxUsdPerRun": 25, "maxWallMinutes": 90 }
}
```

Keep with every target:

1. Source URL, commit, license, build recipe, compiler and flags.
2. Binary hashes, if built.
3. The input generator, smoke tests, held-out tests and the oracle's interface.
4. For binary mode: the analysis evidence (functions, traces, the claimed mechanism and its alternatives).
5. B, kept separate from the original author's rationale.
6. The frozen path, topic arm and control; tool versions.
7. Every run's output, evaluation and judge packets, failed ones included.

## First pilot: FastCDC, source-informed

1. **B, as a verified functional mechanism, not copied code:** cut points chosen from content, bounded chunk sizes, stability under local insertions and deletions.
2. **Hidden corpus** in `eval/`: repetitive, random and structured data; mid-file edits; one-byte prefixes; duplicate files; several target chunk sizes.
3. **`eval/run.sh` metrics**, reported separately:
   - correctness: chunks concatenate to the input, deterministic;
   - robustness: bounded sizes, empty and small files;
   - deduplication: bytes shared across edited versions, compared with fixed-size chunks;
   - cost: CPU time, peak memory.
4. **Do not require Google's exact boundaries.** That would turn the study into mimicry.
5. **Arms:** rer and topic (cut 1, padded), one run each to prove the pipeline, then two or three per arm.
6. **Order:** run the guessers before spending on the doer, and `score-guesses` to find where the path names chunking.

## CI for the harness

`test/ci.sh` runs the harness's own checks with fake models and no API keys; `.github/workflows/ci.yml` runs it on every push in two jobs. **core** checks:
- type check;
- a three-arm smoke study;
- padding, so the topic arm has as many turns as the path;
- the target never reaching the doer or the blind observer;
- leakage scoring and blind judging, including redaction;
- freeze integrity, and refusal of a workdir inside the study directory;
- resume after `kill -9` with nothing asked twice;
- the duplicate tool-id fix and non-fatal observer failures;
- stall, busy-not-stall, and mid-step budget limits.

**sandbox** builds a small image and checks:
- the isolation canary;
- the symlink escape;
- the scheduled internet switch, including real reachability on the runner;
- the evaluator in its container;
- that the doer cannot see the hidden tests.

A manual real-provider canary is deliberately not part of CI. If you add one, keep it `workflow_dispatch`-only with a tight budget, and never require it for contributions.
