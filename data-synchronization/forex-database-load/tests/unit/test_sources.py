from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

import pandas as pd
import pytest

import sources.crypto as crypto
import sources.fiat as fiat

DAY = date(2026, 9, 18)


@pytest.fixture(autouse=True)
def no_retry_wait(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(fiat.time, "sleep", lambda _: None)


def _prices(values: list[Any], dates: list[str], multi_index: bool = True) -> pd.DataFrame:
    columns = pd.MultiIndex.from_tuples([("Close", "ticker")]) if multi_index else ["Close"]
    return pd.DataFrame(values, index=pd.to_datetime(dates), columns=columns)


@pytest.mark.parametrize("multi_index", [True, False])
def test_one_row_gold_download_preserves_decimal_rate(monkeypatch: pytest.MonkeyPatch, multi_index: bool) -> None:
    monkeypatch.setattr(fiat.yf, "download", lambda *args, **kwargs: _prices(["3110.34768"], [str(DAY)], multi_index))
    assert fiat.fetch_range("USD", DAY, DAY) == {DAY: Decimal("100")}


@pytest.mark.parametrize(("code", "forex", "expected"), [("EUR", "1.25", "80"), ("JPY", "150", "15000")])
def test_forex_direction_and_calendar_date_alignment(monkeypatch: pytest.MonkeyPatch, code: str, forex: str, expected: str) -> None:
    def download(ticker: str, **kwargs: Any) -> pd.DataFrame:
        if ticker == "GC=F":
            return _prices(["3110.34768"], ["2026-09-18 00:00:00-04:00"])
        return _prices([forex], ["2026-09-18 00:00:00+00:00"])

    monkeypatch.setattr(fiat.yf, "download", download)
    assert fiat.fetch_range(code, DAY, DAY) == {DAY: Decimal(expected)}


@pytest.mark.parametrize("bad_price", ["NaN", "Infinity", "-Infinity", "0", "-1", None, "garbage"])
def test_invalid_provider_values_are_skipped(monkeypatch: pytest.MonkeyPatch, bad_price: Any) -> None:
    monkeypatch.setattr(fiat.yf, "download", lambda *args, **kwargs: _prices([bad_price], [str(DAY)]))
    assert fiat.fetch_range("USD", DAY, DAY) == {}


def test_malformed_provider_shapes_and_failures_are_recoverable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(fiat.yf, "download", lambda *args, **kwargs: pd.DataFrame({"Open": [1]}))
    assert fiat.fetch_range("USD", DAY, DAY) == {}
    monkeypatch.setattr(fiat.yf, "download", lambda *args, **kwargs: pd.DataFrame([[1, 2]], columns=pd.MultiIndex.from_tuples([("Close", "a"), ("Close", "b")])))
    assert fiat.fetch_range("USD", DAY, DAY) == {}

    def fail(*args: Any, **kwargs: Any) -> pd.DataFrame:
        raise RuntimeError("provider failure")

    monkeypatch.setattr(fiat.yf, "download", fail)
    assert fiat.fetch_range("USD", DAY, DAY) == {}


def test_download_bounds_are_inclusive_and_unadjusted(monkeypatch: pytest.MonkeyPatch) -> None:
    def download(ticker: str, **kwargs: Any) -> pd.DataFrame:
        assert kwargs["start"] == "2026-09-18"
        assert kwargs["end"] == "2026-09-19"
        assert kwargs["auto_adjust"] is False
        return _prices(["3110.34768"] * 3, ["2026-09-17", "2026-09-18", "2026-09-19"])

    monkeypatch.setattr(fiat.yf, "download", download)
    assert fiat.fetch_range("USD", DAY, DAY) == {DAY: Decimal("100")}
    with pytest.raises(ValueError, match="ordered date range"):
        fiat.fetch_range("USD", date(2026, 9, 19), DAY)


def test_csv_preserves_decimal_precision_and_skips_bad_rows(tmp_path: Path) -> None:
    csv_path = tmp_path / "xauusd.csv"
    csv_path.write_text("\ufeffDate,Close\n2026-09-18,3110.34768\n2026-09-19,NaN\n2026-09-20,Infinity\n2026-09-21,0\n2026-09-22,-2\n2026-09-23\nbad,12\n", encoding="utf-8")
    assert fiat.load_file(csv_path, "USD") == {DAY: Decimal("100")}


def test_malformed_csv_does_not_return_partial_data() -> None:
    assert fiat._parse_csv('Date,Close\n2026-09-18,3110.34768\n"unterminated', "USD") == {}
    assert fiat._parse_csv("Date,Open\n2026-09-18,3110.34768", "USD") == {}


def test_crypto_uses_requested_codes_actual_dates_and_quote_direction(monkeypatch: pytest.MonkeyPatch) -> None:
    tickers: list[str] = []

    def download(ticker: str, **kwargs: Any) -> pd.DataFrame:
        tickers.append(ticker)
        if ticker == "GC=F":
            return _prices(["3110.34768"], ["2026-09-18"])
        return _prices(["100000", "200000"], ["2026-09-18", "2026-09-19"])

    monkeypatch.setattr(fiat.yf, "download", download)
    assert crypto.fetch_range(["BTC"], DAY, date(2026, 9, 19)) == {"BTC": {DAY: Decimal("0.001")}}
    assert tickers == ["GC=F", "BTC-USD"]


def test_crypto_never_combines_different_dates(monkeypatch: pytest.MonkeyPatch) -> None:
    def download(ticker: str, **kwargs: Any) -> pd.DataFrame:
        return _prices(["100"], ["2026-09-18" if ticker == "GC=F" else "2026-09-19"])

    monkeypatch.setattr(fiat.yf, "download", download)
    assert crypto.fetch_range(["BTC"], DAY, date(2026, 9, 19)) == {}


def test_unsupported_currencies_fail_before_download(monkeypatch: pytest.MonkeyPatch) -> None:
    def forbidden(*args: Any, **kwargs: Any) -> None:
        pytest.fail("unsupported currency should not trigger a provider call")

    monkeypatch.setattr(fiat.yf, "download", forbidden)
    with pytest.raises(ValueError, match="Unsupported fiat"):
        fiat.fetch_range("ZZZ", DAY, DAY)
    with pytest.raises(ValueError, match="Unsupported crypto"):
        crypto.fetch_range(["ZZZ"], DAY, DAY)
    assert crypto.fetch_range([], DAY, DAY) == {}


@pytest.mark.parametrize("failure", ["exception", "empty"])
def test_transient_download_is_retried_with_bounded_timeout(monkeypatch: pytest.MonkeyPatch, failure: str) -> None:
    calls = []
    pauses = []

    def download(ticker: str, **kwargs: Any) -> pd.DataFrame:
        calls.append(kwargs)
        if len(calls) == 1:
            if failure == "exception":
                raise TimeoutError("temporary provider failure")
            return pd.DataFrame()
        return _prices(["3110.34768"], [str(DAY)])

    monkeypatch.setattr(fiat.yf, "download", download)
    monkeypatch.setattr(fiat.time, "sleep", pauses.append)
    assert fiat.download_closes("GC=F", DAY, DAY) == {DAY: Decimal("3110.34768")}
    assert len(calls) == 2
    assert all(call["timeout"] == 20 and call["threads"] is False for call in calls)
    assert pauses == [1]


def test_provider_retry_stops_after_three_failed_attempts(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []
    pauses = []

    def download(*args: Any, **kwargs: Any) -> pd.DataFrame:
        calls.append(None)
        return pd.DataFrame()

    monkeypatch.setattr(fiat.yf, "download", download)
    monkeypatch.setattr(fiat.time, "sleep", pauses.append)
    assert fiat.download_closes("GC=F", DAY, DAY) == {}
    assert len(calls) == 3
    assert pauses == [1, 2]


def test_provider_repeated_session_dates_must_agree(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(fiat.yf, "download", lambda *args, **kwargs: _prices(["100", "101"], [str(DAY), str(DAY)]))
    assert fiat.download_closes("GC=F", DAY, DAY) == {}
    monkeypatch.setattr(fiat.yf, "download", lambda *args, **kwargs: _prices(["100", "100.00"], [str(DAY), str(DAY)]))
    assert fiat.download_closes("GC=F", DAY, DAY) == {DAY: Decimal("100")}


@pytest.mark.parametrize(
    "source",
    [
        "Date,Close,Close\n2026-09-18,100,200\n",
        "Date,Date,Close\n2026-09-18,2026-09-19,100\n",
        "Date,Close\n2026-09-18,3110.34768\n2026-09-18,6220.69536\n",
    ],
)
def test_ambiguous_csv_rejects_the_entire_file(source: str) -> None:
    assert fiat._parse_csv(source, "USD") == {}


def test_identical_csv_duplicates_are_idempotent_and_extra_cells_are_rejected() -> None:
    source = "Date,Close\n2026-09-18,3110.34768\n2026-09-18,3110.347680\n2026-09-19,123,unmapped\n"
    assert fiat._parse_csv(source, "USD") == {DAY: Decimal(100)}


def test_conversion_precision_is_independent_of_process_decimal_context(monkeypatch: pytest.MonkeyPatch) -> None:
    from decimal import localcontext

    gold = {DAY: Decimal("3110.34768")}
    monkeypatch.setattr(fiat, "download_closes", lambda *args: {DAY: Decimal("1.23456789")})
    with localcontext() as context:
        context.prec = 64
        expected = (Decimal(100) / Decimal("1.23456789")).quantize(Decimal("0.00000001"))
    with localcontext() as context:
        context.prec = 4
        actual = fiat.fetch_range("GBP", DAY, DAY, gold_prices=gold)[DAY]
        assert fiat._parse_csv("Date,Close\n2026-09-18,3110.34768", "USD") == {DAY: Decimal(100)}
    assert actual.quantize(Decimal("0.00000001")) == expected
