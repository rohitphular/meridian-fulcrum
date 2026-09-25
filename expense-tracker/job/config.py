import json
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]  # meridian-fulcrum/
_ENVS_FILE = _REPO_ROOT / "expense-tracker" / "cicd" / "envs.json"
_SA_FILE = _REPO_ROOT / "local" / "configs" / "gcp_service_account.json"

# Current expense-tracker storage. A job must explicitly support this contract
# before credentials are loaded or a Sheets connection is opened.
SOURCE_CONTRACT = "single-leg-master-v1"

SHEET_NAMES = {
    "transactions": "transaction_master",
    "accounts": "account_master",
    "categories": "category_master",
    "rates": "rates",
    "subscriptions": "subscription_master",
}

QUOTE_CURRENCY = "GBP"


def load(env: str) -> dict:
    if env not in ("dev", "prod"):
        raise ValueError(f"env must be 'dev' or 'prod', got: {env!r}")

    with open(_ENVS_FILE) as f:
        envs = json.load(f)

    env_cfg = envs.get(env, {})
    spreadsheet_id = env_cfg.get("spreadsheet_id")
    if not spreadsheet_id:
        raise ValueError(f"No spreadsheet_id found for env '{env}' in {_ENVS_FILE}")

    if not _SA_FILE.exists():
        raise FileNotFoundError(f"Service account file not found: {_SA_FILE}")

    return {
        "env": env,
        "spreadsheet_id": spreadsheet_id,
        "service_account": str(_SA_FILE),
        "sheets": SHEET_NAMES,
        "quote_currency": QUOTE_CURRENCY,
        "source_contract": SOURCE_CONTRACT,
    }
