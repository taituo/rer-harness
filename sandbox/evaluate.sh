#!/usr/bin/env bash
# Run the frozen hidden tests against one run's work, in a fresh container with no network. The tests get a copy of
# the work, so they cannot change the record. Called by `node rer.ts evaluate` with:
#   RER_WORKDIR   the doer's project directory
#   RER_EVAL_DIR  the hidden tests; must contain run.sh, called as `sh /eval/run.sh <copy of the work>`,
#                 which prints one JSON object of metrics on stdout
#   RER_OUT       where the JSON goes
# RER_EVAL_IMAGE picks the image (default rer-sandbox, the doer's own toolchain).
set -euo pipefail
docker run --rm --network none \
  -v "$RER_WORKDIR:/work:ro" -v "$RER_EVAL_DIR:/eval:ro" \
  "${RER_EVAL_IMAGE:-rer-sandbox}" \
  sh -c 'cp -r /work /tmp/work && cd /tmp/work && sh /eval/run.sh /tmp/work' > "$RER_OUT.tmp"
mv "$RER_OUT.tmp" "$RER_OUT"
