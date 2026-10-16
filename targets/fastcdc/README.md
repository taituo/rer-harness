# Pilot target: content-defined chunking

The first target from [docs/targets.md](../../docs/targets.md): source-informed, with hidden acceptance tests that judge what the researcher delivers on a contract, not on its likeness to FastCDC.

| File | Role | Seen by the doer |
|---|---|---|
| `target.md` | B: the mechanism | no |
| `questions.md` | the path (a **draft**: review it, or redo it with `design`) | yes |
| `control.md` | same voice and length, no path | yes (control arm) |
| `pushes.md` | the study's pushes plus `deliver`, the same packaging request for every arm | yes |
| `eval/` | hidden tests and their private seed | no (forbidden path, checked every run) |
| `reference/` | three chunkers that exist only to test the evaluator | no |
| `analysis.md` | the frozen analysis plan | no |
| `manifest.json` | provenance | no |

The `deliver` push asks every arm, at the end, for `./split FILE` (or `split.py` / `split.sh`), printing piece lengths. It names the interface, never the method, so the tests have something to call without telling anyone how to pass them.

**Before a real study, make your own private seed.** The committed seed is public and only for CI:

```bash
python3 -c "import secrets,json; print(json.dumps({'seed': secrets.randbits(48)}))" > targets/fastcdc/eval/private-seeds.local.json
```

It is git-ignored. `freeze` hashes it, so the committed freeze file pre-registers the seed without revealing it. Keep a private copy, because the hash is only checkable against the original.

```bash
targets/fastcdc/selftest.sh                                   # the evaluator must tell good from fixed from broken
node rer.ts models targets/fastcdc/experiment.json
node rer.ts guess  targets/fastcdc/experiment.json --arm rer  # where does the draft path give chunking away?
node rer.ts freeze targets/fastcdc/experiment.json            # then commit
nohup node rer.ts auto targets/fastcdc/experiment.json > runs/fastcdc.log 2>&1 &
```

`auto` ends with `evaluate`. The report has every metric per arm: correctness (exact cover, determinism, edge cases), deduplication after inserts, deletions and appends, its gain over fixed-size pieces of the same mean size, piece-size shape, and throughput. The primary outcome is in `analysis.md`.

The pilot is one run each of rer and topic, to prove the pipeline. Scale to two or three runs per arm before reading anything into it.
