#!/bin/bash
set -euo pipefail
active=
trap 'if [[ -n "$active" ]]; then kill -TERM "$active" 2>/dev/null || :; wait "$active" || :; fi; exit 143' TERM INT HUP
run() {
	local name=$1 duration=$2
	shift 2
	printf '%s START %s\n' "$(date -u +%FT%TZ)" "$name"
	timeout --foreground --kill-after=12s "$duration" node prototype/pdf/dist/comparison.js "$@" &
	active=$!
	local status=0
	wait "$active" || status=$?
	active=
	printf '%s END %s status=%s\n' "$(date -u +%FT%TZ)" "$name" "$status"
	return "$status"
}
run detailed-en 240s benchmark detailed-en 3 /bench-out/benchmark-detailed.json
run dense-sv 240s benchmark dense-sv 3 /bench-out/benchmark-dense.json
run year-large-sv 300s benchmark year-large-sv 3 /bench-out/benchmark-year.json
run fixtures 300s render all all /bench-out/fixtures
