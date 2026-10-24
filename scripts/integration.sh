#!/usr/bin/env bash
set -euo pipefail

docker compose run --rm --no-deps --user root \
	-e LIGHTSHOW_INTEGRATION=1 \
	-v "$PWD/.local/admin-password:/run/admin-password:ro" \
	-v "$PWD/tests:/app/tests:ro" \
	api node --import tsx --test tests/integration/system.test.ts
