from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def local_datetime(value: Any, timezone_name: str, field: str) -> datetime:
    """Resolve a local wall time without guessing an offset during DST transitions."""
    try:
        zone = ZoneInfo(timezone_name)
    except (ZoneInfoNotFoundError, ValueError, TypeError) as error:
        raise ValueError(f"{field}: invalid_timezone") from error
    raw = str(value).strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?", raw) is None:
        raise ValueError(f"{field}: expected_local_datetime_without_offset")
    try:
        naive = datetime.fromisoformat(raw)
    except ValueError as error:
        raise ValueError(f"{field}: invalid_datetime") from error
    first = naive.replace(tzinfo=zone, fold=0)
    second = naive.replace(tzinfo=zone, fold=1)
    try:
        valid = [candidate for candidate in (first, second) if candidate.astimezone(timezone.utc).astimezone(zone).replace(tzinfo=None) == naive]
    except OverflowError as error:
        raise ValueError(f"{field}: datetime_out_of_range") from error
    if not valid:
        raise ValueError(f"{field}: nonexistent_local_time")
    if len(valid) == 2 and first.utcoffset() != second.utcoffset():
        raise ValueError(f"{field}: ambiguous_local_time")
    return valid[0]
