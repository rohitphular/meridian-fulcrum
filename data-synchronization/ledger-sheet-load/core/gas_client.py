from __future__ import annotations

import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

# Bulk imports of a large monthly file can take minutes inside Apps Script.
_TIMEOUT_SECONDS = 360
_CLIENT_UA = "ledger-sheet-load"


class GasError(RuntimeError):
    """A failed call. The message is a safe code: never a URL, PIN or row value."""


class GasClient:
    """Calls the expense-tracker GAS web app the way the app does.

    GET carries the PIN in the query string, as the app's GET calls do; POST carries it
    in the JSON body. GAS answers both with a 302 to the response; urllib follows it and
    turns the POST into a GET, which is what Apps Script expects.
    """

    def __init__(self, script_url: str, pin: str) -> None:
        self._script_url = script_url
        self._pin = pin

    def get(self, action: str, **params: str) -> dict[str, Any]:
        query = urllib.parse.urlencode({"action": action, "pin": self._pin, "ua": _CLIENT_UA, **params})
        return self._send(urllib.request.Request(f"{self._script_url}?{query}", method="GET"), action)

    def post(self, action: str, **body: Any) -> dict[str, Any]:
        payload = json.dumps({"action": action, "pin": self._pin, "ua": _CLIENT_UA, **body}).encode("utf-8")
        request = urllib.request.Request(self._script_url, data=payload, method="POST", headers={"Content-Type": "application/json"})
        return self._send(request, action)

    def _send(self, request: urllib.request.Request, action: str) -> dict[str, Any]:
        # Errors are re-raised without chaining: urllib errors can carry the GET URL, which holds the PIN.
        try:
            with urllib.request.urlopen(request, timeout=_TIMEOUT_SECONDS) as response:
                text = response.read().decode("utf-8")
        except urllib.error.HTTPError as error:
            raise GasError(f"http_error:{action}:{error.code}") from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise GasError(f"network_error:{action}") from None
        try:
            result = json.loads(text)
        except json.JSONDecodeError:
            raise GasError(f"invalid_response:{action}") from None
        if not isinstance(result, dict):
            raise GasError(f"invalid_response:{action}")
        return result


def expect_ok(label: str, response: dict[str, Any]) -> dict[str, Any]:
    """Stops on anything but a clean result; bulk imports can return ok with failed rows.

    The full response (row errors included) goes to the terminal only, never to the log file.
    """
    if response.get("ok") is True and not response.get("failed"):
        return response
    print(f"FAILED: {label}", file=sys.stderr)
    print(json.dumps(response, indent=2, ensure_ascii=False)[:4000], file=sys.stderr)
    error = response.get("error") if isinstance(response.get("error"), str) else ("rows_failed" if response.get("failed") else "not_ok")
    raise GasError(f"{error}:{label}")
