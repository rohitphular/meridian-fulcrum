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
    monkeypatch.setattr(fetcher, "get_client", lambda _: client)
    monkeypatch.setattr(config, "source_enabled", lambda _: True)
    monkeypatch.setattr(fetcher, "get_currencies", lambda _, kind: ["USD"] if kind == "fiat" else ["BTC"])
    monkeypatch.setattr(fetcher.fiat, "fetch_range", lambda *args: {DAY: Decimal(100)})
    monkeypatch.setattr(fetcher.crypto, "fetch_range", lambda *args: {"BTC": {DAY: Decimal("0.001")}})
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
    monkeypatch.setattr(fetcher.crypto, "fetch_range", lambda *args: {})
    with pytest.raises(RuntimeError, match="missing_tracked"):
        fetcher.CurrencyRatesJob(None).run(DAY, END)
    client.cursor.assert_not_called()
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
    client.cursor.assert_not_called()
    client.commit.assert_not_called()
    client.rollback.assert_called_once()
    client.close.assert_called_once()
