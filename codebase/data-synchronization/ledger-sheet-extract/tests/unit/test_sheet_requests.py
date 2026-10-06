from collections.abc import Callable
from unittest.mock import MagicMock

import pytest
from gspread.exceptions import APIError

import sheets.requests as sheet_requests
from sheets.requests import SheetsRequests


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []

    def monotonic(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        assert seconds > 0
        self.sleeps.append(seconds)
        self.now += seconds


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> FakeClock:
    clock = FakeClock()
    monkeypatch.setattr(sheet_requests.time, "monotonic", clock.monotonic)
    monkeypatch.setattr(sheet_requests.time, "sleep", clock.sleep)
    monkeypatch.setattr(sheet_requests.random, "uniform", lambda _lower, _upper: 0.0)
    return clock


def _api_error(status_code: int) -> APIError:
    response = MagicMock()
    response.status_code = status_code
    response.json.return_value = {"error": {"code": status_code, "message": "sensitive response body"}}
    return APIError(response)


def test_sequential_requests_leave_headroom_below_the_minute_quota(clock: FakeClock) -> None:
    limiter = SheetsRequests()
    starts = []

    def request() -> int:
        starts.append(clock.now)
        return len(starts)

    for expected in range(1, 62):
        assert limiter.call(request) == expected

    assert starts == [1.25 * index for index in range(61)]
    assert sum(0 <= start < 60 for start in starts) == 48


def test_slow_requests_do_not_add_an_unnecessary_delay(clock: FakeClock) -> None:
    limiter = SheetsRequests()

    def slow_request() -> str:
        clock.now += 2
        return "done"

    assert limiter.call(slow_request) == "done"
    assert limiter.call(slow_request) == "done"
    assert clock.now == 4
    assert clock.sleeps == []


def test_rate_limit_retries_allow_the_minute_quota_to_refill(clock: FakeClock) -> None:
    limiter = SheetsRequests()
    starts = []

    def request() -> str:
        starts.append(clock.now)
        if clock.now < 60:
            raise _api_error(429)
        return "recovered"

    assert limiter.call(request) == "recovered"
    assert starts == [0, 5, 15, 35, 75]
    assert clock.sleeps == [5, 10, 20, 40]
    assert limiter.call(lambda: "next") == "next"
    assert clock.now == 76.25


def test_exhausted_retries_are_bounded_and_never_log_response_text(clock: FakeClock, monkeypatch: pytest.MonkeyPatch) -> None:
    limiter = SheetsRequests()
    error = _api_error(429)
    request = MagicMock(side_effect=error)
    logger = MagicMock()
    monkeypatch.setattr(sheet_requests, "logger", logger)
    monkeypatch.setattr(sheet_requests.random, "uniform", lambda _lower, _upper: 0.75)

    with pytest.raises(RuntimeError, match="^sheets_api_rate_limit_exhausted$") as raised:
        limiter.call(request)

    assert raised.value.__cause__ is error
    assert request.call_count == 6
    assert clock.sleeps == [5.75, 10.75, 20.75, 40.75, 60]
    assert logger.warning.call_count == 5
    logger.error.assert_called_once_with("call: status=429 attempts=6 reason=sheets_api_rate_limit_exhausted")
    assert "sensitive response body" not in str(logger.mock_calls)


@pytest.mark.parametrize("status_code", [400, 401, 403, 404, 500, 503])
def test_non_quota_api_failures_propagate_without_retry(clock: FakeClock, status_code: int) -> None:
    limiter = SheetsRequests()
    error = _api_error(status_code)
    request = MagicMock(side_effect=error)

    with pytest.raises(APIError) as raised:
        limiter.call(request)

    assert raised.value is error
    request.assert_called_once_with()
    assert clock.sleeps == []
    assert limiter.call(lambda: "next") == "next"
    assert clock.now == 1.25


@pytest.mark.parametrize("error_factory", [ConnectionError, ValueError])
def test_non_api_failures_propagate_without_retry(clock: FakeClock, error_factory: Callable[[], Exception]) -> None:
    error = error_factory()
    request = MagicMock(side_effect=error)

    with pytest.raises(type(error)) as raised:
        SheetsRequests().call(request)

    assert raised.value is error
    request.assert_called_once_with()
    assert clock.sleeps == []
