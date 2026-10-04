"""Safe error codes: snake_case codes with optional `:part` suffixes, never data."""

from __future__ import annotations

import re

_CODE = re.compile(r"[a-z_]+(?::[A-Za-z0-9_.=\[\]-]+)*")


def error_code(error: BaseException) -> str:
    if isinstance(error, KeyboardInterrupt):
        return "interrupted"
    text = str(error)
    return text if _CODE.fullmatch(text) else "see_module_logs"
