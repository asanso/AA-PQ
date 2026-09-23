#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
while IFS= read -r -d '' source; do
  node --check "$source"
done < <(find frontend explorer scripts tests -type d -name node_modules -prune -o -type f \( -name '*.mjs' -o -name '*.js' \) -print0)
node --test tests/*.test.mjs explorer/user-operation.test.mjs
python3 -m unittest discover -s tests/pipeline -p 'test_*.py' -v
