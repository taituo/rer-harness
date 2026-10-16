# RER harness

Runs a Reverse Eureka Reconstruction study on [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable), unattended: a doer model walks a frozen question path toward a solution it is never told about, two observers follow and discuss, a control arm gets the same treatment without the path, and every step lands in one SQLite file per run that can be published as the raw record.

The code is `rer.ts` and `live.html`. Everything the models read lives in `study/` as Markdown plus one JSON config.

## Run the whole study

```bash
npm install                                # exact versions pinned
node rer.ts design study/experiment.json   # optional: designer drafts the path from target.md
#   write questions.md and control.md (same voice, same length; control has no path)
node rer.ts freeze study/experiment.json   # then commit freeze.json
nohup node rer.ts auto study/experiment.json > runs/auto.log 2>&1 &
```

`auto` does everything and keeps going on its own:

1. Checks every model exists and has credentials, before spending anything.
2. Runs the guessers for each arm (the leakage test).
3. Runs `auto.runs` repetitions of every arm, alternating the order (rer, control, control, rer, …) so time of day and provider drift don't line up with one arm. For each run it starts a fresh sandbox container, checks isolation, runs the path, and exports transcripts.
4. A crash, a killed process or a reboot loses nothing: the supervisor restarts the worker with growing backoff, finished runs are skipped, and an unfinished run continues from its last step (every submission has a request id, so nothing is asked twice). Each restart is visible in the record as a new `rer.session` entry.
5. It stops for good on anything a restart cannot fix: files changed since freeze, isolation failed, missing credentials, a model changed mid-run. That is exit code 3 and a notification.

Per-run budget (`budget.maxUsd`) is checked every two seconds while the doer works, not just between steps; crossing it aborts the doer and ends the run, recorded as such. Cost is computed from token counts and catalog prices, not from what a provider reports.

`--faux` runs the whole thing offline with fake models, to check a study before paying for it.

## Watch it live

The running process serves `http://127.0.0.1:7777` (`live.port`, `live.host`): the researcher and each observer side by side, streaming as they think, call tools and get output, with step markers, interventions, retries and per-conversation cost. Only that process may open the run's database, which is why the view is served from it. From a phone: an SSH tunnel (`ssh -L 7777:127.0.0.1:7777 host`) or Tailscale.

Without the page: `runs/status.json` always says what is happening (study, run, step, phase, cost, restarts), and `notify` runs a shell command with `$RER_MESSAGE` at every step, intervention, run end and error, for example `curl -s -d "$RER_MESSAGE" ntfy.sh/your-topic`.

## Löyly: intervening

Drop a `.txt` file into the run's inbox (`runs/inbox-<run>/`, printed at start).

- `@push deeper` sends that push from `pushes.md`. Written in advance and frozen, it carries nothing about the target: the run stays clean. An unknown id is moved to `rejected/` instead of stopping the run.
- Anything else is free text: delivered, and the run is marked `rer.contaminated` from that point. Analyze those runs separately.

## Talking to observers

Each column on the live page has a message box. Type to an observer and it answers in its own column, mid-run; nothing you say to an observer ever reaches the researcher. Without the page, drop a `.txt` into `runs/inbox-<run>/observer-<name>/`. Both paths are recorded the same way, as `rer.intervention` entries in that observer's transcript.

A message to a blind observer is also marked `rer.human-contact`, because you know the target and it does not: anything you say could end its blindness, so analyze its later comments with that in mind.

The researcher's box sends the same thing as the inbox: `@push <id>` stays clean, free text asks for confirmation and marks the run contaminated.

## Observers

Each observer gets a digest of every step (capped by `digest.maxChars`, keeping the start and the end), and read-only tools to go deeper whenever it wants: `transcript` (the doer's full transcript, including reasoning and complete outputs), `files` (list and read the doer's project files) and `search` (regex over both). The doer never gets these tools, so the transcripts and the observers' discussion cannot reach it.

Blind observers speak first and never see what informed observers say, so a blind observer stays blind for the whole run and "did the blind one notice the same thing" remains a real comparison. `blindSeesInformed: true` turns that off.

## What the harness guarantees

| Claim in a paper | How it is backed |
|---|---|
| The path was fixed before the run | `freeze` hashes every study file, the sandbox files, the harness and the lockfile; runs refuse if anything changed |
| The doer had no network and no access to study files | before each run, through the doer's own shell: curl, Python, DNS and pip must fail; study and harness directories must be invisible; a positive control must pass (a broken sandbox would otherwise look perfectly isolated). Results are stored in the run |
| The doer's file tools could not escape | read/write/edit run on the host, so every path is resolved through symlinks and must stay in the run's workdir. Tested at every start with a real symlink to the study directory |
| The doer never saw the target, the arm, or the observers | the target goes only to the designer and informed observers; the workdir is a neutral hash; observers are separate conversations with one-way flow |
| Every human intervention is visible | interventions are their own entry kind; free text writes a contamination marker |
| Failures did not silently change the conversation | provider errors are retried inside the call (`modelRetries`); a call that still fails is resubmitted at most `retries` times and each resubmission is recorded as `rer.retry` |
| The run is the record | one SQLite file per run: every message, tool call and result, timing, cost, config, file hashes, isolation result, package versions |

## Files in `study/`

| File | Who sees it |
|---|---|
| `experiment.json` | the harness |
| `questions.md` | the doer (rer arm). Steps separated by a line with only `---`. `<!-- comments -->` are author notes, never sent |
| `control.md` | the doer (control arm): same tone and ambition, no path |
| `pushes.md` | the doer: frozen pushes (`## id`), used by `autoPushes` (after every step, every arm), `afterPath` (open phase after the path) and the inbox |
| `doer.md` | the doer's standing instructions |
| `target.md` | the designer and informed observers only |
| `observer.md`, `designer.md`, `guess.md` | observers, designer, guessers |

The two observer-facing strings in the code (how a step is handed over, how the target is introduced) can be replaced with `templates` in the config.

## Single commands

`node rer.ts run|export <config> --arm rer --run 1`, `node rer.ts guess <config> --arm rer`. With `sandbox.start` set, `run` starts the container itself.

## Isolation

`sandbox/start.sh` starts a container with `--network none` and only the run's workdir mounted at the same path; `sandbox/shell.sh` runs the doer's commands in it. Install what the doer may need in `sandbox/Dockerfile`, since the container cannot download anything. Any other wrapper works: point `sandbox.shell` at it and the canary tells you whether it isolates.

## Status

Tested end to end with fake models in a real `--network none` container: the full `auto` study (2 arms × 2 runs + guessers), the worker killed with `kill -9` mid-run and resumed by the supervisor without duplicate messages, a symlink escape attack on read and write, budget abort in the middle of a step, menu, free and invalid interventions, observer tools including a path escape attempt, blind observers never receiving informed text, the model-mismatch and missing-credentials stops, and the live view in a browser. Not yet run against real model APIs, and `sandbox/Dockerfile` was not built here (Docker Hub was unreachable). Pi Durable is experimental; keep the pinned versions for the length of a study.

Faux-only test hooks: `RER_FAUX_TPS` (tokens per second), `RER_FAUX_COST` (USD per million tokens), `RER_FAUX_TOOLS` (a scripted list of tool calls for the doer).
