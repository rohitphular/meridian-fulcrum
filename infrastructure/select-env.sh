#!/usr/bin/env bash
# The one environment picker for the root Makefile targets.
#
# Usage: select-env.sh [NAME]
#   NAME given (make ... ENV=NAME): validates it and prints it — no question.
#   NAME empty: lists the environments in infrastructure/envs.json, asks once, prints the choice.
# The menu and errors go to stderr, so callers capture only the name: ENV="$(bash select-env.sh "$ENV")".
set -euo pipefail

ENVS_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/envs.json"
NAME="${1:-}"

ENVS=()
while IFS= read -r line; do
  ENVS+=("$line")
done < <(python3 - "$ENVS_FILE" <<'PYTHON'
import json
import sys
with open(sys.argv[1]) as f:
    for key in json.load(f):
        if not key.startswith("_"):
            print(key)
PYTHON
)

# Checked first: under bash 3.2 (macOS) with set -u an empty array is "unbound".
if [[ ${#ENVS[@]} -eq 0 ]]; then
  echo "ERROR: infrastructure/envs.json declares no environments." >&2
  exit 1
fi

if [[ -n "$NAME" ]]; then
  for env in "${ENVS[@]}"; do
    if [[ "$env" == "$NAME" ]]; then echo "$NAME"; exit 0; fi
  done
  echo "ERROR: unknown environment '$NAME'. infrastructure/envs.json declares: ${ENVS[*]}" >&2
  exit 1
fi

echo "" >&2
i=1
for env in "${ENVS[@]}"; do
  echo "  $i) $env" >&2
  i=$((i + 1))
done
echo "" >&2
printf "Select environment: " >&2
CHOICE=""
read -r CHOICE || true
if [[ "$CHOICE" =~ ^[0-9]+$ && "$CHOICE" -ge 1 && "$CHOICE" -le ${#ENVS[@]} ]]; then
  echo "${ENVS[$((CHOICE - 1))]}"
  exit 0
fi
echo "Invalid choice '$CHOICE'." >&2
exit 1
