# Analysis plan: content-defined chunking pilot

## Question
Does the question path improve what the researcher delivers over the same opening question without the path (topic arm)?

## Primary outcome
`dedup_gain_over_fixed` from the hidden evaluator, rer vs topic, on runs whose `exact_cover_rate` is 1.0.

## Secondary outcomes
exact_cover_rate and edge cases (correctness); piece_max_over_mean and piece_cv (shape); throughput_mb_s (cost); dollars per run; leak point per arm (score-guesses); blind judge "verified" and "overclaims"; distance to the target (informed judge).

## Decision rule
Pilot: one run per arm, to prove the pipeline. It supports nothing on its own. The scaled study (two or three runs per arm) reports every run's numbers and the per-arm range; a path effect is claimed only if every rer run beats every topic run on the primary outcome.

## Exclusions
Runs marked rer.contaminated; runs ending "stalled" (reported separately); runs whose deliverable fails exact cover are reported with dedup "not applicable", not as zero.

## Standing instructions
doer.md as in study/, identical across arms. The `deliver` push is the same for every arm and names only the interface, not the method.
