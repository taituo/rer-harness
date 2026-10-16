#!/usr/bin/env bash
# The doer's bash runs here: inside a container with no network that only sees its own project directory.
# Pi calls this as its shell ("-c <command>"), from the project directory, which is mounted at the same path inside.
exec docker exec -i -w "$PWD" "${RER_SANDBOX:-rer-sandbox}" bash "$@"
