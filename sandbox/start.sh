#!/usr/bin/env bash
# Start the sandbox for one run: no route out (an internal network; sandbox/net.sh can add one), only the run's workdir
# mounted (at the same path), nothing else from the host.
#   sandbox/start.sh <workdir> [container-name]
# The workdir is printed by `node rer.ts run` on its first line; create it first with `mkdir -p`.
set -euo pipefail
mkdir -p "$1"; workdir="$(realpath "$1")"
name="${2:-rer-sandbox}"
here="$(dirname "$(realpath "$0")")"
docker image inspect rer-sandbox >/dev/null 2>&1 || docker build -q -t rer-sandbox "$here" >/dev/null  # rebuild: docker rmi rer-sandbox
docker rm -f "$name" >/dev/null 2>&1 || true
docker network inspect rer-offline >/dev/null 2>&1 || docker network create --internal rer-offline >/dev/null
docker run -d --name "$name" --network rer-offline \
  -v "$workdir:$workdir" -w "$workdir" \
  --user "$(id -u):$(id -g)" -e HOME=/tmp \
  rer-sandbox sleep infinity >/dev/null
echo "sandbox $name up: no route out, mounted $workdir"
docker inspect -f '{{.Image}}' "$name"
