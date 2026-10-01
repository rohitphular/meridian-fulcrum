from __future__ import annotations

import getpass
import re
import sys


def _validated(pin: str, totp: str | None) -> tuple[str, str | None]:
    if not pin:
        raise ValueError("pin_required")
    if totp is not None and not re.fullmatch(r"[0-9]{6}", totp):
        raise ValueError("invalid_authenticator_code")
    return pin, totp


def read_credentials() -> tuple[str, str]:
    """Interactive: asks for the PIN (hidden) and a fresh authenticator code."""
    pin = getpass.getpass("PIN: ")
    totp = input("Authenticator code: ").strip()
    _validated(pin, totp)
    return pin, totp


def read_credentials_from_stdin(with_code: bool) -> tuple[str, str | None]:
    """Unattended: the pipeline writes the PIN, then (with_code) the code, one per line.

    Nothing is prompted or echoed. Both stay in memory: never in arguments,
    environment variables or logs.
    """
    pin = sys.stdin.readline().rstrip("\r\n")
    totp = sys.stdin.readline().strip() if with_code else None
    return _validated(pin, totp)
