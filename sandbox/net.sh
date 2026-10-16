#!/usr/bin/env bash
# Turn the doer's internet on or off while it runs:  sandbox/net.sh on|off [container]
# The container lives on an internal network with no route out; "on" attaches it to the default bridge as well.
set -uo pipefail
name="${2:-rer-sandbox}"
case "${1:-}" in
  on)  docker network connect bridge "$name" 2>&1 | grep -v "already exists" >&2; true ;;
  off) docker network disconnect bridge "$name" 2>&1 | grep -v "is not connected" >&2; true ;;
  *)   echo "usage: net.sh on|off [container]" >&2; exit 2 ;;
esac
# Report the state the container actually ended up in, from Docker itself (no tools needed inside the container).
docker inspect -f '{{if index .NetworkSettings.Networks "bridge"}}on{{else}}off{{end}}' "$name"
