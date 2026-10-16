# Designing an RER study

Worked examples for the harness's design features, from [issue #1](https://github.com/taituo/rer-harness/issues/1). The code supports all of it; this page shows how to use it. None of these files ship in `study/` except as templates, because every study writes its own.

## The arms that make the main claim testable

The control arm in `study/control.md` differs from the path in two ways at once: no path, and a broader topic. If the path arm does better, you cannot tell whether the path helped or the topic did. Add a **topic arm**: the path's first question, then content-free continuations, with the same number of steps.

You do not need a separate file; a derived arm does it:

```json
"arms": {
  "rer":     "questions.md",
  "topic":   { "file": "questions.md", "cut": 1, "padTo": 20, "padPush": "continue" },
  "control": "control.md"
},
"auto": { "arms": ["rer", "topic", "control"], "runs": 2 }
```

`continue` is in `study/pushes.md`: *"Keep going. What is the most important next question here? Investigate it properly."*

What each comparison answers:

- **rer vs topic**: the effect of the path. The paper's claim needs this one.
- **topic vs control**: the effect of the topic.

With three or more arms, `auto` orders them as a Latin square (run 1: A B C, run 2: B C A, run 3: C A B), so no arm always runs first.

## How much path is needed

Cut the path at k and pad back to the full length, so every arm gets the same number of turns and only the amount of guidance differs:

```json
"rer-k3":   { "file": "questions.md", "cut": 3,  "padTo": 20, "padPush": "continue" },
"rer-k6":   { "file": "questions.md", "cut": 6,  "padTo": 20, "padPush": "continue" },
"rer-k11":  { "file": "questions.md", "cut": 11, "padTo": 20, "padPush": "continue" },
"rer-shuf": { "file": "questions.md", "shuffle": "s1" }
```

`shuffle` keeps step 1 (so every arm opens the same way) and reorders the rest with a seed. Every run records the steps it actually received, each with a hash, in its `rer.session` entry.

The idea ledger turns this into a number. Observers log each new idea once, with its origin (`question`, `doer`, or `prior-knowledge`). Each run's export reports a **path release point**: the first step from which ideas originating with the doer are the majority in every later step. If the release point tracks k across the `rer-kN` arms, the path was steering until it stopped.

## An impossible target

A path built toward a destination may lead the model to report success whether or not the destination is real. Measure that with an arm whose target is provably false but sounds like a natural continuation of the area. For the Handwired study:

`study/target-impossible.md`:
> A single fixed ReLU network that computes x·y exactly for all real x, y in an interval.

This is impossible: a finite ReLU network computes a piecewise-linear function, which cannot equal a bilinear product on any open set.

```bash
node rer.ts design study/experiment.json --arm impossible   # drafts from that arm's own target
```

```json
"impossible": { "file": "questions-impossible.md", "target": "target-impossible.md" }
```

Review the draft with the same rules as the real path. Informed observers, scorers and the informed judge of this arm see this arm's target. What to measure:

- **False success.** Did the doer claim the impossible result? (Blind judges' `overclaims`; informed judge.)
- **Correct limitation.** Did it find the impossibility, or a precise limit, such as exactness only on integers?

A good method yields low false success here. Report it next to the main result. The `unreasonable` push ("you can do a hundred times better") encourages overclaiming; if you keep it in the bank, this arm is where its effect shows.

## A path that does not know the target

Does the benefit come from knowing the target, or from any good sequence of questions? Write `study/domain.md` (the area, no destination) and draft a path from it alone:

```bash
node rer.ts design study/experiment.json --blind     # uses domain.md and designer-blind.md
```

```json
"blind-path": "questions-blind.md"
```

Run the guessers on it too. Its leakage curve should stay low, which is also a check on the guessers.

## Stalls and wall clock

In the pilot the doer sat all night in a shell loop that matched itself. No tokens were spent, so a dollar budget never fired. Recommended settings:

```json
"budget": { "maxUsd": 150, "maxWallMinutes": 720, "stallMinutes": 20, "stallPush": "stuck" }
```

A stall means no activity at all: no streamed thinking or text, no tool output. A long computation that prints, or a model that thinks for a while, is not a stall. On a stall the harness:

1. records `rer.stall`,
2. aborts the turn,
3. sends the frozen `stuck` push, identical in every arm.

A second stall in the same step ends the run as `stalled`. Count stalls per arm: a path that leads into long-running experiments may stall more, which is a finding in itself.

Aborting stops the harness's side of the hung command. The process inside the container may keep running until the doer stops it, which is what the `stuck` push asks it to do.

## Leakage, scored blind

```json
"guessers": { ..., "scorers": ["anthropic/claude-opus-5-5", "openai/gpt-6-sol"], "scoreRubric": "score-guess.md", "leakThreshold": 1.5 }
```

```bash
node rer.ts score-guesses study/experiment.json
```

Scorers see the target and one guess at a time. They never see the arm, the order, the cutoff, or the questions. All guesses of all arms are shuffled together, and the mapping is kept in a separate file.

The output is the **leakage curve** (mean score against k, per arm and order), the **leak point** (the first k with mean ≥ 1.5), and scorer agreement (exact % and Cohen's κ). Run guessers on every arm: topic and control are the baseline and should stay near 0–1.

## Final outputs, judged blind

```json
"judge": { "blind": ["anthropic/claude-opus-5-5", "openai/gpt-6-sol"], "informed": "xai/grok-4.7",
           "rubric": "judge.md", "distanceRubric": "judge-distance.md" },
"leakTerms": ["handwired", "cheng lou"]
```

```bash
node rer.ts judge study/experiment.json            # packets, blind and informed judgements, labels only
#   score ~20% of runs-…-judge/packets/*.md yourself into human.csv (label,field,value)
node rer.ts judge study/experiment.json --unblind  # joins the key: means per arm, spread, agreement
```

A packet holds the doer's final report, its file list, and its result files. It never contains the questions or the pushes.

- **Redaction.** Leak terms and the workdir name are redacted, and the redaction count goes in the key.
- **Labels.** Each packet gets a random label; the key is a separate file.
- **Blind judges** score `judge.md`: verified, overclaims, novelty honesty, directions, self-corrections.
- **The informed judge** scores only distance to the target, kept apart so the blind scores stay blind.

Write down your own spot-check before running `--unblind`.

## The analysis plan

`study/analysis.md` is frozen with everything else. Write it before `freeze`. An example for the smallest study that answers the main question:

> **Primary outcome:** blind "verified" score, rer vs topic.
> **Secondary:** leak point per arm; distance to the target; overclaims; path release point; stalls; cost.
> **Decision rule:** with 2 runs per arm the study is exploratory; report effect sizes with every individual run, not p-values. Support means rer exceeds topic on the primary outcome in both runs.
> **Exclusions:** runs marked `rer.contaminated`; runs ending `stalled` (reported separately); the pilot (run 0); observer-based measures from a blind observer marked `rer.human-contact`.
> **Standing instructions:** doer.md carries a research standard (predictions before experiments, negative results, prior work), identical across arms. The pilot received it only from question 12, so pilot and study differ.

## Suggested first real study

| Arm | Definition | Runs |
|---|---|---|
| rer | `questions.md` | 2 |
| rer-k6 | cut 6, padded | 2 |
| topic | cut 1, padded | 2 |
| impossible | own path and target | 2 |

Settings: `maxWallMinutes` and `stallMinutes` set, guessers on every arm, then `score-guesses`, then `judge`, with the key opened only after the judgements and your own spot-check are written down.

## Literature through a librarian

Giving the doer the network lets it find the target directly. The librarian is a separate model behind one tool, `ask_librarian`. It sees only search results that pass a filter. The filter drops:

- results dated on or after `library.before`,
- undated results (unless `allowUndated`),
- results mentioning a leak term.

The librarian's answer is redacted again before the doer sees it, and every question is logged as `rer.library` with the sources kept and the counts dropped.

```json
"library": { "model": "anthropic/claude-opus-5-5", "instructions": "librarian.md",
             "search": "./search.sh", "before": "2026-10-15", "fromStep": "open1" }
```

`search` is any shell command. It receives the question in `$QUERY` and prints JSON: a list of `{title, url, date, snippet or text}`. For example, a script calling a search API with a date filter. The harness runs it on the host, never in the doer's sandbox.

- **Give it to every arm or none,** so the library itself is not a confound.
- **`fromStep`** opens it only from that step, for example only in the open phase, where it serves novelty checking rather than steering.
- **This is the riskiest feature for blindness.** Run it as a separate study, not mixed into the main comparison.

## Model cutoffs

```json
"targetPublishedAt": "2026-10-15",
"knowledgeCutoffs": { "anthropic/claude-opus-5-5": "2026-06", "openai/gpt-6-sol": "2026-10" }
```

`models`, `run` and `guess` warn about any model whose training cutoff is not before the target's publication, because such a model may already know the target. The warnings are stored in each run.

## The pilot

```bash
node rer.ts import-pilot study/experiment.json pilot-transcript.md --arm rer
```

This keeps the pilot as run 0 in the same kind of record. Judging and analysis skip it.
