#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PYTHONPATH="$ROOT/backend" python -m unittest discover -s "$ROOT/backend/tests" -v
cd "$ROOT/frontend"
npm test
npm run build
