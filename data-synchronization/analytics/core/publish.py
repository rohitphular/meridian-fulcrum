"""publish: send a built generation to the Sheet's report tabs, switching slots last.

1. Take the analytics lock; pick the newest good generation (built or published).
2. Read report_meta: the live slot and generation. Unless forced (mode publish), skip when
   the live generation already has the same anchor date, contract version and source
   watermark (nothing the reports read has changed).
3. Write the inactive slot completely: report_data_<slot> (payloads cut into chunks of at
   most payload_chunk_max_chars, RAW), then report_index_<slot>. Each tab is sized to the
   exact grid first, and rows go in size-bounded batches.
4. Write report_status, then report_meta (one row: active_slot, generation_id, …) last.
   A failure before that write leaves the previous generation live: the app reads only the
   slot report_meta names.
5. Mark the run published.
"""

from __future__ import annotations

import hashlib
import json
import time
from datetime import datetime, timezone
from typing import Any, Protocol

from py_db_migrate.adapters.postgres import get_client
from py_db_migrate.core.config import ConnectionConfig
from py_logging import get_logger

import core.config as config
import database.runs as runs

logger = get_logger(__name__)

# Characters per values.update request: well under the API's request size limit, so a
# batch of 45 K-character chunks is a handful of requests per slot.
REQUEST_MAX_CHARS = 1_500_000


class Sheets(Protocol):
    def read_values(self, title: str) -> list[list[str]] | None: ...
    def prepare(self, title: str, rows: int, cols: int) -> None: ...
    def write(self, title: str, start_row: int, values: list[list[Any]]) -> None: ...
    def request_count(self) -> int: ...


def _tabs() -> tuple[dict[str, dict[str, Any]], int, list[str]]:
    spec = config.contract("sheet-tabs")
    return {tab["name"]: tab for tab in spec["tabs"]}, spec["payload_chunk_max_chars"], spec["slots"]


def read_meta(sheets: Sheets) -> dict[str, str] | None:
    values = sheets.read_values("report_meta")
    if not values or len(values) < 2:
        return None
    return dict(zip(values[0], values[1]))


def chunk(text: str, size: int) -> list[str]:
    return [text[index : index + size] for index in range(0, len(text), size)] or [""]


def payload_rows(outputs: list[tuple[str, str, Any]], size: int) -> tuple[list[list[Any]], list[list[Any]], int]:
    """(data rows, index rows, characters) for report_data_x / report_index_x; row 1 is the header."""
    data: list[list[Any]] = []
    index: list[list[Any]] = []
    characters = 0
    for report_id, variant_key, payload in outputs:
        text = json.dumps(payload, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
        characters += len(text)
        parts = chunk(text, size)
        index.append([report_id, variant_key, len(data) + 2, len(parts), hashlib.sha256(text.encode()).hexdigest()[:16]])
        data.extend([report_id, variant_key, number, part] for number, part in enumerate(parts, start=1))
    return data, index, characters


def _write_tab(sheets: Sheets, title: str, columns: list[str], rows: list[list[Any]]) -> None:
    """Exact grid, then header + rows in batches bounded by characters (a one-row tab is one write)."""
    sheets.prepare(title, len(rows) + 1, len(columns))
    batch: list[list[Any]] = [columns]
    start, size = 1, 0
    for row in rows:
        row_size = sum(len(str(value)) for value in row)
        if batch and size + row_size > REQUEST_MAX_CHARS:
            sheets.write(title, start, batch)
            start, batch, size = start + len(batch), [], 0
        batch.append(row)
        size += row_size
    if batch:
        sheets.write(title, start, batch)


def _unchanged(live: dict[str, Any] | None, candidate: dict[str, Any]) -> bool:
    keys = ("anchor_date", "contract_version", "source_watermark")
    return live is not None and all(live[key] == candidate[key] for key in keys)


def publish_generation(conn: Any, sheets: Sheets, *, force: bool) -> str | None:
    """Publishes the newest good generation; returns its id, or None when skipped."""
    started = time.monotonic()
    tabs, size, slots = _tabs()
    candidate = runs.latest_good(conn)
    conn.rollback()
    if candidate is None:
        raise RuntimeError("nothing_to_publish")
    meta = read_meta(sheets)
    live_id = meta.get("generation_id", "") if meta else ""
    live = runs.get(conn, live_id) if live_id else None
    conn.rollback()
    if not force and (live_id == candidate["generation_id"] or _unchanged(live, candidate)):
        logger.info(f"publish: skipped=true reason=unchanged live_generation_id={live_id} candidate_generation_id={candidate['generation_id']}")
        return None
    active = meta.get("active_slot", "") if meta else ""
    slot = slots[1] if active == slots[0] else slots[0]
    generation_id = candidate["generation_id"]
    with conn.cursor() as cursor:
        cursor.execute("SELECT report_id::text, variant_key, payload FROM analytics.report_output WHERE generation_id = %s ORDER BY report_id, variant_key", (generation_id,))
        outputs = cursor.fetchall()
        cursor.execute("SELECT report_id::text, definition_updated_at, status, coalesce(error_code, '') FROM analytics.report_result WHERE generation_id = %s ORDER BY report_id", (generation_id,))
        results = cursor.fetchall()
    conn.rollback()
    data, index, characters = payload_rows(outputs, size)
    published_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    logger.info(f"publish: generation_id={generation_id} slot={slot} payloads={len(index)} data_rows={len(data)} chars={characters}")

    _write_tab(sheets, f"report_data_{slot}", tabs[f"report_data_{slot}"]["columns"], data)
    _write_tab(sheets, f"report_index_{slot}", tabs[f"report_index_{slot}"]["columns"], index)
    _write_tab(sheets, "report_status", tabs["report_status"]["columns"], [[*row, published_at] for row in results])
    meta_row = [
        slot,
        generation_id,
        published_at,
        candidate["contract_version"],
        candidate["anchor_date"].isoformat(),
        json.dumps(candidate["source_watermark"], separators=(",", ":"), sort_keys=True, default=str),
        candidate["reports_ok"],
        candidate["reports_failed"],
        candidate["rows_not_loaded"],
        ";".join(candidate["missing_currencies"] or []),
    ]
    _write_tab(sheets, "report_meta", tabs["report_meta"]["columns"], [meta_row])  # the switch: last
    runs.mark_published(conn, generation_id, published_at)
    logger.info(
        f"publish: complete=true generation_id={generation_id} slot={slot} published_at={published_at} requests={sheets.request_count()} chars={characters} seconds={time.monotonic() - started:.1f}"
    )
    return generation_id


def publish(db_config: ConnectionConfig, spreadsheet_id: str, service_account_file: str, *, force: bool = True, sheets: Sheets | None = None) -> str | None:
    conn = get_client(db_config)
    try:
        runs.take_lock(conn)
        if sheets is None:
            from sheets.report_sheets import ReportSheets

            sheets = ReportSheets(service_account_file, spreadsheet_id)
        return publish_generation(conn, sheets, force=force)
    finally:
        conn.close()  # also releases the session lock
