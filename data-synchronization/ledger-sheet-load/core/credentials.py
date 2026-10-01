from __future__ import annotations

import getpass
import re


def read_credentials() -> tuple[str, str]:
    """Asks for the PIN (hidden) and a fresh authenticator code.

    Both stay in memory: never in arguments, environment variables or logs.
    """
    pin = getpass.getpass("PIN: ")
    totp = input("Authenticator code: ").strip()
    if not pin:
        raise ValueError("pin_required")
    if not re.fullmatch(r"[0-9]{6}", totp):
        raise ValueError("invalid_authenticator_code")
    return pin, totp
