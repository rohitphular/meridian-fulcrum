import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

import pytest

from core.gas_client import GasClient, GasError, expect_ok

_PIN = "9731"


class _FakeGas(BaseHTTPRequestHandler):
    """Answers like Apps Script: the /exec call returns 302 to a GET that serves the JSON."""

    seen: list[dict] = []
    reply: dict = {"ok": True}

    def log_message(self, *args: object) -> None:
        pass

    def do_POST(self) -> None:
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        _FakeGas.seen.append({"method": "POST", "body": body, "content_type": self.headers["Content-Type"]})
        self.send_response(302)
        self.send_header("Location", "/echo")
        self.end_headers()

    def do_GET(self) -> None:
        url = urlparse(self.path)
        if url.path == "/exec":
            _FakeGas.seen.append({"method": "GET", "query": parse_qs(url.query)})
            self.send_response(302)
            self.send_header("Location", "/echo")
            self.end_headers()
            return
        if url.path == "/broken":
            self.send_response(500)
            self.end_headers()
            return
        text = "<html>not json</html>" if url.path == "/html" else json.dumps(_FakeGas.reply)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(text.encode())


@pytest.fixture
def server() -> Iterator[str]:
    _FakeGas.seen = []
    _FakeGas.reply = {"ok": True, "rows": 3}
    httpd = HTTPServer(("127.0.0.1", 0), _FakeGas)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{httpd.server_port}"
    httpd.shutdown()


def test_post_follows_gas_redirect_as_get_and_sends_pin_only_in_body(server: str) -> None:
    result = GasClient(f"{server}/exec", _PIN).post("create_categories_bulk", csv="id\n1\n", dry_run=True)
    assert result == {"ok": True, "rows": 3}
    assert _FakeGas.seen == [
        {"method": "POST", "content_type": "application/json", "body": {"action": "create_categories_bulk", "pin": _PIN, "ua": "ledger-sheet-load", "csv": "id\n1\n", "dry_run": True}}
    ]


def test_get_sends_action_pin_and_parameters(server: str) -> None:
    GasClient(f"{server}/exec", _PIN).get("verify", totp="123456")
    assert _FakeGas.seen[0]["query"] == {"action": ["verify"], "pin": [_PIN], "ua": ["ledger-sheet-load"], "totp": ["123456"]}


@pytest.mark.parametrize("path,code", [("/broken", "http_error:verify:500"), ("/html", "invalid_response:verify")])
def test_transport_failures_raise_codes_without_url_or_pin(server: str, path: str, code: str) -> None:
    with pytest.raises(GasError) as error:
        GasClient(f"{server}{path}", _PIN).get("verify")
    assert str(error.value) == code
    assert error.value.__cause__ is None and error.value.__suppress_context__


def test_unreachable_host_is_a_network_error() -> None:
    with pytest.raises(GasError, match="^network_error:verify$"):
        GasClient("http://127.0.0.1:9/exec", _PIN).get("verify")


@pytest.mark.parametrize(
    "response,code",
    [
        ({"ok": False, "error": "invalid_csv_rows", "errors": ["Row 3: private value"]}, "invalid_csv_rows:load:a.csv"),
        ({"ok": True, "failed": 2}, "rows_failed:load:a.csv"),
        ({"ok": "yes"}, "not_ok:load:a.csv"),
    ],
)
def test_expect_ok_stops_on_errors_and_failed_rows(response: dict, code: str, capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(GasError) as error:
        expect_ok("load:a.csv", response)
    assert str(error.value) == code
    assert "FAILED: load:a.csv" in capsys.readouterr().err


def test_expect_ok_returns_clean_response() -> None:
    assert expect_ok("x", {"ok": True, "failed": 0, "created": 1}) == {"ok": True, "failed": 0, "created": 1}
