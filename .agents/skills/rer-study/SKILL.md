---
name: rer-study
description: Run, monitor and steer a Reverse Eureka Reconstruction (RER) study with this repository's harness (rer.ts on Pi Durable). Use when asked to set up a study, write or check a question path, freeze it, start or resume the unattended run, watch progress, intervene, talk to observers, or collect and interpret results. Works with Anthropic, OpenAI, xAI or OpenCode Go models.
license: MIT
metadata:
  opencode/slash: "true"
---

# Operating an RER study

You are the operator of a scientific experiment. The harness does the mechanics; your job is to keep the experiment valid. When speed and validity conflict, choose validity and say so.

The design in one paragraph: a **doer** model walks a frozen **question path** toward a known solution (the **target**) it is never told about. A **control arm** gets the same voice, length and pushes with no path. Two **observers** follow each step; the **blind** one never learns the target, the **informed** one knows it. **Guessers** see only the questions and measure how much the path itself leaks. Everything lands in one SQLite file per run.

## Rules that protect the result

1. Nothing the doer reads may mention a study, a test, a target, or known answers. Questions sound like a person talking to a colleague, ambitious and warm.
2. Never edit study files after freezing. If something must change, refreeze and start new run numbers, and say what changed.
3. Never pass `--unfrozen` or `--allow-leaks` on your own. They exist for a human who accepts the cost; they are recorded in the run.
4. Never open a run's `.sqlite` while it runs. Watch through `runs/status.json`, the live page or the log.
5. Intervening on the doer: use `@push <id>` from `study/pushes.md`. Free text contaminates the run; only send it if the human asked, and tell them the run is now marked.
6. Never give the blind observer information about the target. Messages to it are marked `rer.human-contact`.
7. Do not interpret results while runs are still going; do not peek at guess scores before all guesses exist.

## Setup

```bash
npm install
docker build -t rer-sandbox sandbox/          # the doer's machine: no network inside
```

Credentials are environment variables read by Pi: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, and `OPENCODE_API_KEY` for an OpenCode Go subscription. Check before anything else:

```bash
node rer.ts models study/experiment.json                          # every model the config uses: exists? key found?
node rer.ts models study/experiment.opencode-go.json --provider opencode-go   # the Go catalog to choose from
```

On OpenCode Go, budget with `budget.maxTokens` per run; the dollar figures shown are catalog list prices, not what a subscription charges.

## Prepare the path

1. Put the known result in `study/target.md`.
2. Optionally draft with `node rer.ts design <config>`; the draft lands in `runs/questions.draft.md`.
3. Edit it into `study/questions.md`: steps separated by a line with only `---`. Read every step as the doer would and remove anything that names or strongly implies the destination. `<!-- comments -->` are never sent.
4. Write `study/control.md`: same number of steps, same voice and ambition, no direction.
5. Dry run everything offline: `node rer.ts auto <config> --faux`, then read `runs/*-faux/doer.md` to see exactly what the doer received.

## Freeze and start

```bash
node rer.ts freeze study/experiment.json      # writes study/experiment.freeze.json
git add -A && git commit -m "Freeze study"    # the commit is the timestamped preregistration
nohup node rer.ts auto study/experiment.json > runs/auto.log 2>&1 &
```

`auto` runs the guessers, then every arm and repetition in alternating order, each in a fresh sandbox, exports transcripts, and restarts itself after crashes. Running the same command again continues where it stopped; finished runs are skipped.

## Watch

- `runs/status.json`: study, run, step, phase, cost, tokens, restarts. Poll this.
- Live page `http://127.0.0.1:7777`: all conversations streaming side by side, with message boxes.
- `runs/auto.log`: everything, including isolation results at the start of each run.

Exit code 3 / phase `stopped: fatal error` means a restart cannot help. The common causes:

| Message | Meaning | What to do |
|---|---|---|
| `study files changed since freeze` | a study file differs from the freeze | revert it, or refreeze and use new run numbers |
| `isolation canary failed` | the doer could reach the network or the study files | fix the sandbox; never work around it |
| `no credentials for …` | missing API key | set the variable and rerun |
| `… was started with …, config now says …` | model changed mid-run | revert, or use a new run number |

## Steer

Doer (from the live page or by file):
```bash
echo "@push deeper" > runs/inbox-<run>/note.txt
```
Observer, which never reaches the doer:
```bash
echo "What is the weakest claim so far?" > runs/inbox-<run>/observer-B/q.txt
```

## Results

After `study complete`:

1. Guesses: `runs/<name>-<arm>-guesses.jsonl`. Score each answer blind to arm, order and cutoff: 0 unrelated, 1 same area, 2 identifies the target. Then compare: at which cutoff does the path start giving the target away, and how does the shuffled order and the control arm compare?
2. Runs: `runs/<run>/doer.md`, `observer-*.md`, `usage.json`; raw record in `runs/<run>.sqlite`.
3. Compare arms on what the doer actually built and verified, not on how it described it. Note every contaminated run, human contact with the blind observer, retry, restart and budget stop; report them, do not drop them.
4. Report what failed as plainly as what worked.
