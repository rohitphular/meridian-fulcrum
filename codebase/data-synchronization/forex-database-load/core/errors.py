from __future__ import annotations

_SAFE_REASONS = {
    "forex_database_load_job_already_running",
    "invalid_date_range",
    "missing_tracked_currency_rates",
    "no_fiat_data_loaded",
    "empty_invalid_or_future_dated_csv",
    "historical_csv_directory_missing_or_not_absolute",
    "missing_source_configuration",
    "source_enabled_must_be_boolean",
    "invalid_config_mapping",
    "invalid_database_port",
    "invalid_rate_value",
    "rate_outside_storage_precision",
    "invalid_xau_identity_rate",
    "no_rates_to_publish",
    "missing_xau_rate",
    "sheets_api_rate_limit_exhausted",
}
_ENVIRONMENT_NAMES = {"FULCRUM_DB_HOST", "FULCRUM_DB_PORT", "FULCRUM_DB_USER", "FULCRUM_DB_PASSWORD", "FULCRUM_DB_NAME", "MERIDIAN_LOG_ROOT", "FDL_HISTORICAL_CSV_DIR", "FDL_SERVICE_ACCOUNT_FILE"}


def failure_reason(error: Exception) -> str:
    """Keep operator repair codes while excluding provider/DB secret-bearing text."""
    message = str(error)
    if message in _SAFE_REASONS or message in {f"missing_environment_variable:{name}" for name in _ENVIRONMENT_NAMES}:
        return message
    return "see_source_logs"
