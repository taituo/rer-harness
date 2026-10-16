#!/usr/bin/env bash
# Offline checks for the harness itself. No model API keys, no network for the models: everything runs on --faux.
#   test/ci.sh core     type check, smoke study, freeze integrity, resume after kill -9, tool-id fix, observer failure,
#                       stall and budget limits, scoring and judging pipelines, scientific guardrails
#   test/ci.sh docker   the same sandbox the doer gets: isolation canary, symlink escape, internet switch, evaluator
set -uo pipefail
cd "$(dirname "$0")/.."
export NODE_NO_WARNINGS=1
FIX=test/fixture
CFG=$FIX/experiment.json
RUNS=$FIX/runs
failures=0
ok() { echo "ok - $1"; }
bad() { echo "not ok - $1"; failures=$((failures + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
reset() { rm -rf "$RUNS" /tmp/rer-ci-work "$FIX"/*.freeze.json "$FIX"/ci-*.json; }
rer() { node rer.ts "$@"; }
# Query a run's SQLite record: py <db> <python expression over `es` (entries) and `C` (collections)>
py() { python3 - "$1" "$2" <<'EOF'
import sqlite3, json, sys, collections as C
es = [json.loads(r[0]) for r in sqlite3.connect(sys.argv[1]).execute("select record from entries order by id")]
print(eval(sys.argv[2]))
EOF
}
variant() { python3 -c "import json,sys; c=json.load(open('$CFG')); exec(sys.argv[2]); json.dump(c, open('$FIX/' + sys.argv[1], 'w'), indent=2)" "$@"; }
trap reset EXIT
reset

core() {
	check "type check" "[ \$(npx -y -p typescript@5 tsc --noEmit --allowImportingTsExtensions --module nodenext --target es2023 --moduleResolution nodenext --skipLibCheck --strict false rer.ts 2>&1 | grep 'error TS' | grep -v TS2352 | wc -l) -eq 0 ]"

	check "FastCDC evaluator tells content-defined from fixed from broken" "targets/fastcdc/selftest.sh >/dev/null"

	# Smoke: a three-arm study end to end.
	rer freeze $CFG >/dev/null
	timeout 600 node rer.ts auto $CFG --faux > $RUNS.auto.log 2>&1
	check "auto study completes" "grep -q 'study complete' $RUNS.auto.log"
	for arm in rer topic control; do
		check "$arm: summary written, run completed" "python3 -c \"import json; s=json.load(open('$RUNS/ci-$arm-1-faux/summary.json')); assert s['ending']=='completed', s['ending']\""
	done
	check "topic arm gets as many turns as the path (padding)" "[ \"\$(py $RUNS/ci-topic-1-faux.sqlite \"len([e for e in es if e.get('kind')=='rer.session'][0]['data']['steps'])\")\" = \"\$(py $RUNS/ci-rer-1-faux.sqlite \"len([e for e in es if e.get('kind')=='rer.session'][0]['data']['steps'])\")\" ]"
	check "only the informed observer ever sees the target (not the doer, not the blind observer)" "[ \"\$(py $RUNS/ci-rer-1-faux.sqlite \"len({e['conversationId'] for e in es if 'zebrafinch' in json.dumps(e) and e.get('kind')!='rer.session'})\")\" = 1 ] && [ \"\$(py $RUNS/ci-rer-1-faux.sqlite \"sum('zebrafinch' in json.dumps(e) for e in es if e['conversationId']==[x for x in es if x.get('kind')=='rer.session'][0]['conversationId'] and e.get('kind')!='rer.session')\")\" = 0 ]"
	check "guesses written for every arm" "ls $RUNS/ci-*-guesses-faux.jsonl | wc -l | grep -qx 3"

	# Leakage scoring and judging pipelines.
	timeout 300 node rer.ts score-guesses $CFG --faux > /dev/null 2>&1
	check "score-guesses writes the leakage curve" "grep -q 'leak point' $RUNS/ci-leakage-faux/leakage.md"
	check "scorers never see arm names" "[ \"\$(py $RUNS/ci-leakage-faux/scoring.sqlite \"sum(any(a in json.dumps(e) for a in ('topic','control')) for e in es if e.get('kind')=='pi.user')\")\" = 0 ]"
	mkdir -p "/tmp/rer-ci-work/p$(printf ci-rer-1 | sha256sum | cut -c1-8)"
	echo "Built the zebrafinch machine." > "/tmp/rer-ci-work/p$(printf ci-rer-1 | sha256sum | cut -c1-8)/README.md"
	timeout 300 node rer.ts judge $CFG --faux > /dev/null 2>&1
	check "judge packets redact leak terms" "! grep -rqi zebrafinch $RUNS/ci-judge-faux/packets/ && grep -rq redacted $RUNS/ci-judge-faux/packets/"
	check "judge --unblind reports per arm" "node rer.ts judge $CFG --faux --unblind 2>/dev/null | grep -q '| field |'"

	variant ci-inside.json "c['workdir']='work'"
	out=$(node rer.ts run $FIX/ci-inside.json --faux 2>&1); code=$?
	check "a workdir inside the study directory is refused" "[ $code -eq 3 ] && echo \"\$out\" | grep -q 'inside the study directory'"

	# Freeze integrity: a changed study file stops a real run before anything is spent.
	reset; rer freeze $CFG >/dev/null
	echo "extra" >> $FIX/questions.md
	out=$(node rer.ts run $CFG 2>&1); code=$?
	git checkout -q -- $FIX/questions.md 2>/dev/null || sed -i '$ d' $FIX/questions.md
	check "changed study file is refused (exit 3)" "[ $code -eq 3 ] && echo \"\$out\" | grep -q 'changed since freeze'"
	out=$(node rer.ts run $CFG 2>&1); code=$?
	check "unchanged study passes the freeze check" "! echo \"\$out\" | grep -q 'changed since freeze'"

	# Resume after kill -9 mid-step: nothing is asked twice, the run completes.
	reset
	RER_FAUX_TPS=15 node rer.ts run $CFG --faux --run k > $RUNS.k1.log 2>&1 &
	pid=$!
	timeout 120 bash -c "until grep -q 'step 2/' $RUNS.k1.log 2>/dev/null; do sleep 1; done"
	sleep 1; kill -9 $pid; wait $pid 2>/dev/null
	timeout 300 node rer.ts run $CFG --faux --run k > $RUNS.k2.log 2>&1
	check "resumed run completes" "grep -q 'done (completed)' $RUNS.k2.log"
	check "the first question was sent exactly once" "[ \"\$(py $RUNS/ci-rer-k-faux.sqlite \"sum(1 for e in es if e.get('kind')=='pi.user' and 'literally be a network' in json.dumps(e) and e['conversationId']==[x for x in es if x.get('kind')=='rer.session'][0]['conversationId'])\")\" = 1 ]"
	check "the restart is visible in the record" "[ \"\$(py $RUNS/ci-rer-k-faux.sqlite \"sum(1 for e in es if e.get('kind')=='rer.session')\")\" = 2 ]"

	# Issue #3: duplicate tool call ids never reach the provider; observer failures do not stop a run.
	RER_FAUX_DUP_IDS=1 timeout 300 node rer.ts run $CFG --faux --run dup > $RUNS.dup.log 2>&1
	check "duplicate tool ids are made unique before each request" "grep -q 'done (completed)' $RUNS.dup.log && ! grep -q DUPLICATE $RUNS.dup.log"
	variant ci-of.json "c['retries']=0; c['modelRetries']=0"
	RER_FAUX_FAIL_OBSERVERS=1 timeout 300 node rer.ts run $FIX/ci-of.json --faux --run of > $RUNS.of.log 2>&1
	check "a failing observer is recorded and the run goes on" "grep -q 'done (completed)' $RUNS.of.log && grep -q 'observer A failed' $RUNS.of.log"

	# Limits: a silent hung command is a stall (push once, then end); a printing one is not; budgets abort mid-step.
	variant ci-stall.json "c['budget']={'stallMinutes':0.15,'stallPush':'stuck'}; c['observers']=c['observers'][:1]"
	RER_FAUX_TOOLS='[["bash",{"command":"while true; do sleep 15; done"}]]' timeout 300 node rer.ts run $FIX/ci-stall.json --faux --run st > $RUNS.st.log 2>&1
	check "silent hang: stall push sent, second stall ends the run" "grep -q 'done (stalled in q1)' $RUNS.st.log && [ \"\$(py $RUNS/ci-rer-st-faux.sqlite \"sum(1 for e in es if e.get('kind')=='rer.stall')\")\" = 2 ]"
	RER_FAUX_TOOLS='[["bash",{"command":"for i in $(seq 15); do echo tick; sleep 1; done"}]]' timeout 300 node rer.ts run $FIX/ci-stall.json --faux --run busy > $RUNS.busy.log 2>&1
	check "a command that keeps printing is not a stall" "grep -q 'done (completed)' $RUNS.busy.log"
	variant ci-budget.json "c['budget']={'maxUsd':0.15}; c['autoPushes']=['verify','deeper']"
	RER_FAUX_TPS=8 RER_FAUX_COST=300 timeout 300 node rer.ts run $FIX/ci-budget.json --faux --run b > $RUNS.b.log 2>&1
	check "budget aborts in the middle of a step" "grep -q 'budget reached' $RUNS.b.log && ! grep -q 'step 2/' $RUNS.b.log"
}

docker_checks() {
	# RER_CI_PREBUILT=1 uses an existing rer-sandbox image (for machines without registry access).
	if [ -z "${RER_CI_PREBUILT:-}" ]; then docker build -q -t rer-sandbox -f test/Dockerfile.ci test >/dev/null || { bad "build sandbox image"; return; }; fi
	reset
	variant ci-docker.json "
c['sandbox']={'start':'../../sandbox/start.sh','shell':'../../sandbox/shell.sh','net':'../../sandbox/net.sh','container':'rer-ci'}
c['network']={'start':'off','schedule':{'q2':'on','q3':'off'},'announce':{'on':'net-on','off':'net-off'}}
c['evaluator']={'command':'../../sandbox/evaluate.sh','dir':'eval','timeoutMinutes':5}
c['observers']=c['observers'][:1]"
	rer freeze $FIX/ci-docker.json >/dev/null
	RER_FAUX_TOOLS='[["bash",{"command":"python3 -c \"import os; os.symlink(\\\"/\\\", \\\"x\\\")\"; echo {} > results.json"}],["read",{"path":"x/etc/hostname"}]]' \
		timeout 600 node rer.ts run $FIX/ci-docker.json --faux --run d > $RUNS.d.log 2>&1
	DB=$RUNS/ci-rer-d-faux.sqlite
	check "sandboxed run completes" "grep -q 'done (completed)' $RUNS.d.log"
	check "isolation canary: shell works, every probe blocked" "[ \"\$(py $DB \"[e for e in es if e.get('kind')=='rer.session'][0]['data']['isolation']['isolated']\")\" = True ]"
	check "symlink escape through the file tools is blocked" "[ \"\$(py $DB \"sum('outside the project directory' in json.dumps(e) for e in es if e.get('kind')=='pi.tool-result')\")\" -ge 1 ]"
	check "internet switched on before q2 and off before q3, as scheduled" "[ \"\$(py $DB \"[(e['data']['state'],e['data']['step']) for e in es if e.get('kind')=='rer.network']\")\" = \"[('off', None), ('on', 'q2'), ('off', 'q3')]\" ]"
	check "internet actually reachable while on (needs network on the CI runner)" "[ \"\$(py $DB \"[e['data']['reachable'] for e in es if e.get('kind')=='rer.network' and e['data']['state']=='on']\")\" = '[True]' ]"
	timeout 300 node rer.ts evaluate $FIX/ci-docker.json --faux > $RUNS.ev.log 2>&1
	check "hidden tests run in a container against the work" "grep -q '\"has_results\": 1' $RUNS/ci-rer-d-faux/evaluation.json"
	check "the doer could not see the hidden tests" "[ \"\$(py $DB \"[v for k,v in [e for e in es if e.get('kind')=='rer.session'][0]['data']['isolation']['results'].items() if k.endswith('/eval')]\")\" = \"['blocked']\" ]"
	docker rm -f rer-ci >/dev/null 2>&1
}

case "${1:-core}" in
	core) core ;;
	docker) docker_checks ;;
	all) core; docker_checks ;;
	*) echo "usage: test/ci.sh core|docker|all"; exit 2 ;;
esac
echo "$failures failed"
[ $failures -eq 0 ]
