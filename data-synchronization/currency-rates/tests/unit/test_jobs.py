from datetime import date
from decimal import Decimal
from pathlib import Path
from unittest.mock import MagicMock

import pytest

import core.config as config
import core.fetcher as fetcher
import core.historical as historical
from database.upsert import upsert_rates

DAY = date(2026, 9, 18)
END = date(2026, 9, 20)


def _mock_daily(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    client = MagicMock()
    client.cursor.return_value.__enter__.return_value.fetchone.return_value = (True,)
    monkeypatch.setattr(fetcher, "get_client", lambda _: client)
    monkeypatch.setattr(config, "source_enabled", lambda _: True)
    monkeypatch.setattr(fetcher, "get_currencies", lambda _, kind: ["USD"] if kind == "fiat" else ["BTC"])
    monkeypatch.setattr(fetcher.fiat, "download_closes", lambda *args: {DAY: Decimal("3110.34768")})
    monkeypatch.setattr(fetcher.fiat, "fetch_range", lambda *args, **kwargs: {DAY: Decimal(100)})
    monkeypatch.setattr(fetcher.crypto, "fetch_range", lambda *args, **kwargs: {"BTC": {DAY: Decimal("0.001")}})
    return client


def test_crypto_uses_source_date_and_commit_is_atomic(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _mock_daily(monkeypatch)
    fetcher.CurrencyRatesJob(None).run(DAY, END)
    batches = client.cursor.return_value.__enter__.return_value.executemany.call_args_list
    crypto_rows = [row for call in batches for row in call.args[1] if row[0] == "BTC"]
    assert crypto_rows == [("BTC", DAY, Decimal("0.00100000"), "yfinance")]
    client.commit.assert_called_once()
    client.rollback.assert_not_called()
    client.close.assert_called_once()


def test_missing_series_fails_before_any_write(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _mock_daily(monkeypatch)
    monkeypatch.setattr(fetcher.crypto, "fetch_range", lambda *args, **kwargs: {})
    with pytest.raises(RuntimeError, match="missing_tracked"):
        fetcher.CurrencyRatesJob(None).run(DAY, END)
    client.cursor.return_value.__enter__.return_value.executemany.assert_not_called()
    client.commit.assert_not_called()
    client.rollback.assert_called_once()
    client.close.assert_called_once()


def test_write_failure_rolls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _mock_daily(monkeypatch)
    client.cursor.return_value.__enter__.return_value.executemany.side_effect = RuntimeError("database failure")
    with pytest.raises(RuntimeError):
        fetcher.CurrencyRatesJob(None).run(DAY, END)
    client.commit.assert_not_called()
    client.rollback.assert_called_once()
    client.close.assert_called_once()


@pytest.mark.parametrize("rate", [Decimal("NaN"), Decimal("Infinity"), Decimal(0), Decimal(-1), Decimal("0.000000001"), Decimal("100000000000"), 1.2])
def test_invalid_batch_never_reaches_database(rate: object) -> None:
    client = MagicMock()
    with pytest.raises(ValueError):
        upsert_rates(client, [("USD", DAY, Decimal(100), "yfinance"), ("GBP", DAY, rate, "yfinance")])
    client.cursor.assert_not_called()


def test_config_rejects_string_boolean(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    settings = tmp_path / "config.yaml"
    settings.write_text('sources:\n  yfinance:\n    enabled: "false"\n')
    monkeypatch.setattr(config, "_CONFIG_PATH", settings)
    with pytest.raises(ValueError, match="boolean"):
        config.source_enabled("yfinance")


def _mock_historical(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> MagicMock:
    client = MagicMock()
    client.cursor.return_value.__enter__.return_value.fetchone.return_value = (True,)
    monkeypatch.setattr(historical, "get_client", lambda _: client)
    monkeypatch.setattr(config, "db_config", lambda: None)
    monkeypatch.setattr(config, "historical_csv_dir", lambda: str(tmp_path))
    monkeypatch.setattr(config, "source_enabled", lambda _: False)
    monkeypatch.setattr(historical, "get_currencies", lambda *args: ["USD"])
    return client


def test_historical_records_stooq_and_honors_disabled_provider(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    client = _mock_historical(monkeypatch, tmp_path)
    (tmp_path / "xauusd.csv").write_text(f"Date,Close\n{DAY},3110.34768\n")
    provider = MagicMock(side_effect=AssertionError("network forbidden"))
    monkeypatch.setattr(historical.crypto, "fetch_range", provider)
    historical.main()
    first_batch = client.cursor.return_value.__enter__.return_value.executemany.call_args_list[0].args[1]
    assert first_batch == [("USD", DAY, Decimal("100.00000000"), "stooq")]
    provider.assert_not_called()
    client.commit.assert_called_once()
    client.close.assert_called_once()


@pytest.mark.parametrize("csv_text", [None, "Date,Close\ninvalid,123\n", "Date,Close\n9999-01-01,123\n"])
def test_unusable_historical_import_fails_without_writes(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, csv_text: str | None) -> None:
    client = _mock_historical(monkeypatch, tmp_path)
    if csv_text is not None:
        (tmp_path / "xauusd.csv").write_text(csv_text)
    with pytest.raises(SystemExit) as raised:
        historical.main()
    assert raised.value.code == 1
    client.cursor.return_value.__enter__.return_value.executemany.assert_not_called()
    client.commit.assert_not_called()
    client.rollback.assert_called_once()
    client.close.assert_called_once()


def test_daily_rates_share_one_gold_snapshot_across_fiat_and_crypto(monkeypatch: pytest.MonkeyPatch) -> None:
    client = MagicMock()
    client.cursor.return_value.__enter__.return_value.fetchone.return_value = (True,)
    monkeypatch.setattr(fetcher, "get_client", lambda _: client)
    monkeypatch.setattr(config, "source_enabled", lambda _: True)
    monkeypatch.setattr(fetcher, "get_currencies", lambda _, kind: ["USD", "GBP"] if kind == "fiat" else ["BTC"])
    tickers = []

    def download(ticker: str, *_: object) -> dict[date, Decimal]:
        tickers.append(ticker)
        if ticker == "GC=F":
            return {DAY: Decimal("3110.34768") * tickers.count("GC=F")}
        return {DAY: Decimal("2") if ticker == "GBPUSD=X" else Decimal("100000")}

    monkeypatch.setattr(fetcher.fiat, "download_closes", download)
    fetcher.CurrencyRatesJob(None).run(DAY, END)
    batches = client.cursor.return_value.__enter__.return_value.executemany.call_args_list
    rates = {row[0]: row[2] for call in batches for row in call.args[1] if row[0] != "XAU"}
    assert rates == {"USD": Decimal("100"), "GBP": Decimal("50"), "BTC": Decimal("0.001")}
    assert tickers == ["GC=F", "GBPUSD=X", "BTC-USD"]


def test_overlapping_daily_job_stops_before_fetch_or_write(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _mock_daily(monkeypatch)
    client.cursor.return_value.__enter__.return_value.fetchone.return_value = (False,)
    provider = MagicMock(side_effect=AssertionError("should not fetch"))
    monkeypatch.setattr(fetcher.fiat, "download_closes", provider)
    with pytest.raises(RuntimeError, match="currency_rates_job_already_running"):
        fetcher.CurrencyRatesJob(None).run(DAY, END)
    provider.assert_not_called()
    client.cursor.return_value.__enter__.return_value.executemany.assert_not_called()
    client.rollback.assert_called_once()
    client.close.assert_called_once()


def test_overlapping_historical_job_stops_before_import(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    client = _mock_historical(monkeypatch, tmp_path)
    client.cursor.return_value.__enter__.return_value.fetchone.return_value = (False,)
    reader = MagicMock(side_effect=AssertionError("should not import"))
    monkeypatch.setattr(historical.fiat, "load_file", reader)
    with pytest.raises(SystemExit) as raised:
        historical.main()
    assert raised.value.code == 1
    reader.assert_not_called()
    client.cursor.return_value.__enter__.return_value.executemany.assert_not_called()
    client.rollback.assert_called_once()


def test_rate_rounding_does_not_depend_on_global_decimal_precision() -> None:
    from decimal import localcontext

    client = MagicMock()
    with localcontext() as context:
        context.prec = 4
        upsert_rates(client, [("USD", DAY, Decimal("12345.123456785"), "yfinance")])
    stored = client.cursor.return_value.__enter__.return_value.executemany.call_args.args[1]
    assert stored == [("USD", DAY, Decimal("12345.12345679"), "yfinance")]


@pytest.mark.parametrize("source", ["", "sources: null", "sources: {yfinance: {}}", "sources: {yfinance: null}"])
def test_incomplete_source_config_reports_an_actionable_code(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, source: str) -> None:
    settings = tmp_path / "config.yaml"
    settings.write_text(source)
    monkeypatch.setattr(config, "_CONFIG_PATH", settings)
    with pytest.raises(ValueError, match="invalid_config_mapping|missing_source_configuration"):
        config.source_enabled("yfinance")


@pytest.mark.parametrize("value", ["", "relative/path", "/this/path/does/not/exist"])
def test_historical_directory_fails_before_database_access(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    monkeypatch.setenv("CR_HISTORICAL_CSV_DIR", value)
    with pytest.raises(ValueError, match="missing_environment_variable|historical_csv_directory"):
        config.historical_csv_dir()


@pytest.mark.parametrize("value", ["bad", "0", "65536", "-1"])
def test_database_port_is_validated_before_connection(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    monkeypatch.setenv("FULCRUM_DB_PORT", value)
    with pytest.raises(ValueError, match="invalid_database_port"):
        config.db_config()


def test_required_database_settings_report_names_without_secret_values(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("FULCRUM_DB_HOST", raising=False)
    monkeypatch.delenv("FULCRUM_DB_PORT", raising=False)
    with pytest.raises(ValueError, match="missing_environment_variable:FULCRUM_DB_HOST"):
        config.db_config()


def test_error_messages_keep_controlled_repair_codes_and_redact_external_details() -> None:
    from core.errors import failure_reason

    assert failure_reason(RuntimeError("currency_rates_job_already_running")) == "currency_rates_job_already_running"
    assert failure_reason(ValueError("missing_environment_variable:FULCRUM_DB_PASSWORD")) == "missing_environment_variable:FULCRUM_DB_PASSWORD"
    assert failure_reason(RuntimeError("password=sensitive token=also_sensitive")) == "see_source_logs"
