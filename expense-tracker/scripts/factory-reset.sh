#!/usr/bin/env bash
# Factory-reset the expense-tracker spreadsheet for one environment.
# Deletes the 11 CSV-backed tabs (every other tab, including 'dummy', 'rates' and
# the audit log, is kept), recreates them, re-imports local/files/*.csv and
# finally reapplies the configured tab order.
# All work is done by the GAS web app; this script only makes HTTP calls.
#
# Usage:
#   ./factory-reset.sh <env>     — env is a key in cicd/envs.json (dev, prod)
# Optional:
#   FACTORY_RESET_DATA_DIR=/path  — CSV folder (default: <repo>/local/files)
#   FACTORY_RESET_ENVS_FILE=/path — environment registry (default: cicd/envs.json)
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$APP_DIR/.." && pwd)"
ENVS_FILE="${FACTORY_RESET_ENVS_FILE:-$APP_DIR/cicd/envs.json}"
DATA_DIR="${FACTORY_RESET_DATA_DIR:-$REPO_DIR/local/files}"

# Import order follows data dependencies. Each entry is "file|import action|file_type";
# every file goes to its entity's own CSV import endpoint, the same one the app uses.
# The monthly transaction files are picked up below.
IMPORTS=(
  "account_types.csv|create_account_types_bulk|"
  "category_master.csv|create_categories_bulk|"
  "account_master.csv|import_account_data|account_master"
  "account_deposit_details.csv|import_account_data|account_deposit"
  "account_investment_property.csv|import_account_data|account_investment_property"
  "account_investment_stocks.csv|import_account_data|account_investment_stocks"
  "account_liability_credit_card.csv|import_account_data|account_liability_credit_card"
  "account_liability_mortgage.csv|import_account_data|account_liability_mortgage"
  "account_liability_personal_loan.csv|import_account_data|account_liability_personal_loan"
  "subscription_master.csv|create_subscriptions_bulk|"
)
# Tabs the existing list endpoints create; account_types and the detail tabs are
# created by their own imports.
RECREATE_ACTIONS=(list_transactions list_categories list_accounts list_subscriptions)

fail() { echo "ERROR: $*" >&2; exit 1; }
for tool in curl jq; do command -v "$tool" > /dev/null || fail "$tool is required."; done

# ── Environment ──────────────────────────────────────────────────────────────

ENV_ARG="${1:-}"
[[ -n "$ENV_ARG" ]] || fail "usage: $0 <env>"
[[ -f "$ENVS_FILE" ]] || fail "$ENVS_FILE not found."
[[ "$ENV_ARG" != _* ]] && jq -e --arg env "$ENV_ARG" 'has($env)' "$ENVS_FILE" > /dev/null || fail "unknown env '$ENV_ARG'."
SCRIPT_URL="$(jq -r --arg env "$ENV_ARG" '.[$env].script_url // empty' "$ENVS_FILE")"
SPREADSHEET_ID="$(jq -r --arg env "$ENV_ARG" '.[$env].spreadsheet_id // empty' "$ENVS_FILE")"
[[ -n "$SCRIPT_URL" && -n "$SPREADSHEET_ID" ]] || fail "script_url and spreadsheet_id must be set for '$ENV_ARG' in envs.json."

# ── Files ────────────────────────────────────────────────────────────────────

shopt -s nullglob
TX_FILES=("$DATA_DIR"/transaction_master_*.csv)
shopt -u nullglob
[[ ${#TX_FILES[@]} -gt 0 ]] || fail "no transaction_master_*.csv files in $DATA_DIR."
for entry in "${IMPORTS[@]}"; do
  [[ -f "$DATA_DIR/${entry%%|*}" ]] || fail "missing $DATA_DIR/${entry%%|*}."
done
for file in "${TX_FILES[@]}"; do IMPORTS+=("$(basename "$file")|create_transactions_bulk|"); done

# ── Confirmation and credentials ─────────────────────────────────────────────

echo ""
echo "Factory reset — environment: $ENV_ARG"
echo "  Spreadsheet : $SPREADSHEET_ID"
echo "  Deletes     : account_types, category_master, account_master, 6 account detail tabs,"
echo "                subscription_master, transaction_master (all other tabs are kept)"
echo "  Imports     : ${#IMPORTS[@]} files from $DATA_DIR"
echo ""
read -r -p "Type '$ENV_ARG' to continue: " CONFIRM
[[ "$CONFIRM" == "$ENV_ARG" ]] || fail "confirmation did not match; nothing was changed."

read -r -s -p "PIN: " FR_PIN; echo ""
read -r -p "Authenticator code: " FR_TOTP
[[ -n "$FR_PIN" && "$FR_PIN" != *[\"\\]* ]] || fail "PIN is empty or contains unsupported characters."
[[ "$FR_TOTP" =~ ^[0-9]{6}$ ]] || fail "the authenticator code must be 6 digits."
export FR_PIN

# ── HTTP helpers (credentials never appear in command arguments) ─────────────

# GET via a curl config on stdin; GAS answers with a redirect, so follow it.
gas_get() {
  local action="$1"; shift
  {
    printf 'url = "%s"\nget\n' "$SCRIPT_URL"
    printf 'data-urlencode = "action=%s"\n' "$action"
    printf 'data-urlencode = "pin=%s"\n' "$FR_PIN"
    printf 'data-urlencode = "ua=factory-reset.sh"\n'
    for pair in "$@"; do printf 'data-urlencode = "%s"\n' "$pair"; done
  } | curl -sS -L --max-time 360 -K -
}

# POST a JSON body read from stdin. Do not use -X POST: the redirect must become a GET.
gas_post() {
  curl -sS -L --max-time 360 -H 'Content-Type: application/json' --data-binary @- "$SCRIPT_URL"
}

# Stop on anything but a clean result; bulk imports can return ok with failed rows.
expect_ok() {
  local label="$1" response="$2"
  if ! jq -e 'type == "object" and .ok == true and ((.failed // 0) == 0)' <<< "$response" > /dev/null 2>&1; then
    echo "FAILED: $label" >&2
    jq '.' <<< "$response" >&2 2> /dev/null || printf '%s\n' "${response:0:2000}" >&2
    exit 1
  fi
}

# One request per file: { action, csv, dry_run[, file_type] }.
import_body() {
  local entry="$1" dry_run="$2" file action file_type
  IFS='|' read -r file action file_type <<< "$entry"
  jq -n --arg action "$action" --arg file_type "$file_type" --rawfile csv "$DATA_DIR/$file" --argjson dry_run "$dry_run" \
    '{ action: $action, pin: env.FR_PIN, ua: "factory-reset.sh", csv: $csv, dry_run: $dry_run }
     + (if $file_type == "" then {} else { file_type: $file_type } end)'
}

# ── 1. Sign in (PIN + authenticator code, as the app does) ───────────────────

echo ""
echo "[1/6] Verifying credentials…"
expect_ok "verify" "$(gas_get verify "totp=$FR_TOTP")"

# ── 2. Preflight: every file must parse before anything is deleted ───────────

echo "[2/6] Checking CSV files…"
for entry in "${IMPORTS[@]}"; do
  response="$(import_body "$entry" true | gas_post)"
  expect_ok "preflight ${entry%%|*}" "$response"
  printf '      %-40s %s rows\n' "${entry%%|*}" "$(jq -r '.rows' <<< "$response")"
done

# ── 3. Delete the CSV-backed tabs ────────────────────────────────────────────

echo "[3/6] Deleting tabs…"
response="$(jq -n --arg id "$SPREADSHEET_ID" \
  '{ action: "factory_reset_delete_sheets", pin: env.FR_PIN, ua: "factory-reset.sh", confirm: "factory-reset", spreadsheet_id: $id }' | gas_post)"
expect_ok "delete sheets" "$response"
echo "      deleted: $(jq -r '.deleted | join(", ")' <<< "$response")"

# ── 4. Recreate tabs through the existing list endpoints ─────────────────────

echo "[4/6] Recreating tabs…"
for action in "${RECREATE_ACTIONS[@]}"; do
  expect_ok "$action" "$(gas_get "$action")"
  echo "      $action"
done

# ── 5. Import every dataset in dependency order ──────────────────────────────

echo "[5/6] Importing data…"
for entry in "${IMPORTS[@]}"; do
  response="$(import_body "$entry" false | gas_post)"
  expect_ok "import ${entry%%|*}" "$response"
  printf '      %-40s %s created · %s updated\n' "${entry%%|*}" "$(jq -r '.created // 0' <<< "$response")" "$(jq -r '.updated // 0' <<< "$response")"
done

# ── 6. Reset the tab order through the existing sheet-order code ─────────────

echo "[6/6] Arranging sheet tabs…"
response="$(jq -n '{ action: "arrange_sheet_tabs", pin: env.FR_PIN, ua: "factory-reset.sh" }' | gas_post)"
expect_ok "arrange sheet tabs" "$response"
echo "      $(jq -r 'if .changed then "tabs arranged (\(.moved) moved)" else "tabs already in order" end' <<< "$response")"

echo ""
echo "Factory reset complete for $ENV_ARG."
