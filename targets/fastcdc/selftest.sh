#!/usr/bin/env bash
# Prove the hidden evaluator discriminates before trusting it on a run: a content-defined chunker must beat fixed-size
# pieces after edits, fixed-size pieces must gain nothing, and a chunker that drops bytes must fail exact cover.
set -euo pipefail
cd "$(dirname "$0")"
m() { python3 eval/evaluate.py "reference/$1" | python3 -c "import json,sys; print(json.load(sys.stdin).get('$2'))"; }
fail=0
check() { if python3 -c "import sys; sys.exit(0 if ($2) else 1)"; then echo "ok - $1"; else echo "not ok - $1"; fail=1; fi; }
gear=$(m gear dedup_gain_over_fixed); fixed=$(m fixed dedup_gain_over_fixed); broken=$(m broken exact_cover_rate)
check "content-defined reference beats fixed-size pieces (gain $gear)" "$gear > 0.3"
check "fixed-size reference gains nothing (gain $fixed)" "abs($fixed) < 0.02"
check "broken reference fails exact cover (rate $broken)" "$broken < 0.5"
exit $fail
