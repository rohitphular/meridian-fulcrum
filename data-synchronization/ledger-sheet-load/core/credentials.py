from __future__ import annotations

import base64
import binascii
import getpass
import hashlib
import hmac
import os
import re
import struct
import sys
import time

# The one pair of names for the expense-tracker sign-in, shared with the GAS Script
# Properties and infrastructure/.env.<env>. Never logged.
PIN_VARIABLE = "MERIDIAN_FULCRUM_PIN"
SECRET_VARIABLE = "MERIDIAN_FULCRUM_SECRET"


def _validated(pin: str, totp: str | None) -> tuple[str, str | None]:
    if not pin:
        raise ValueError("pin_required")
    if totp is not None and not re.fullmatch(r"[0-9]{6}", totp):
        raise ValueError("invalid_authenticator_code")
    return pin, totp


def totp_code(secret: str, at: float | None = None) -> str:
    """RFC 6238 code (HMAC-SHA1, 30 s, 6 digits), matching generateTotp in app-auth.gs."""
    cleaned = re.sub(r"[^A-Z2-7]", "", secret.upper())
    try:
        # A real key is at least 80 bits (16 Base32 characters); a 6-digit code or the PIN is not.
        key = base64.b32decode(cleaned + "=" * (-len(cleaned) % 8)) if len(cleaned) >= 16 and not cleaned.isdigit() else b""
    except binascii.Error:
        key = b""
    if not key:
        print(f"FAILED: {SECRET_VARIABLE} must be the Base32 TOTP secret (letters A-Z and digits 2-7, as in the Script Properties), not an authenticator code or the PIN.", file=sys.stderr)
        raise ValueError("stored_secret_not_base32")
    counter = int((time.time() if at is None else at) // 30)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFFFFFF
    return f"{value % 1_000_000:06d}"


def stored_credentials() -> tuple[str, str] | None:
    """PIN and a freshly generated code from the environment, when both variables are set.

    One set without the other is an error rather than a silent fallback to prompting.
    """
    pin = os.environ.get(PIN_VARIABLE, "")
    secret = os.environ.get(SECRET_VARIABLE, "")
    if not pin and not secret:
        return None
    if not pin or not secret:
        raise ValueError("incomplete_stored_credentials")
    return pin, totp_code(secret)


def read_credentials() -> tuple[str, str]:
    """Interactive: the stored credentials, else asks for the PIN (hidden) and a fresh code."""
    stored = stored_credentials()
    if stored is not None:
        return stored
    pin = getpass.getpass("PIN: ")
    totp = input("Authenticator code: ").strip()
    _validated(pin, totp)
    return pin, totp


def read_credentials_from_stdin(with_code: bool) -> tuple[str, str | None]:
    """Unattended: the stored credentials, else the PIN then (with_code) the code on stdin, one per line.

    Nothing is prompted or echoed.
    """
    stored = stored_credentials()
    if stored is not None:
        return stored[0], stored[1] if with_code else None
    pin = sys.stdin.readline().rstrip("\r\n")
    totp = sys.stdin.readline().strip() if with_code else None
    return _validated(pin, totp)
