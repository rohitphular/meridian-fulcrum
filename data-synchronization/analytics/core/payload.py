"""Payload builders, the variant key and the payload check (contract/report-payload.md).

Money is XAU grams, rounded to 9 decimals (nanograms). Text never carries an amount: it
uses {0}, {1} … placeholders with a `values` list (see `text`).
"""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import quote

CONTRACT_VERSION = 1
MONEY_FORMATS = ("money", "money2", "money_delta")
FORMATS = (*MONEY_FORMATS, "percent", "percent_delta", "count", "days", "text", "date", "month", "progress", "local")
CHART_KINDS = ("line", "bar", "hbar", "stacked", "stacked_hbar", "area", "mixed", "donut", "pie", "gauge", "waterfall")
TONES = ("positive", "negative", "neutral", "warn", "muted", "primary", "highlight")


def grams(value: float | None) -> float | None:
    return None if value is None else round(float(value), 9)


def money(value: float | None, fmt: str = "money") -> dict[str, Any]:
    return {"value": grams(value), "format": fmt}


def text(template: str, *values: dict[str, Any]) -> dict[str, Any]:
    """Text with values: text('Down {0} on last month', money(12.5, 'money_delta'))."""
    return {"text": template, "values": list(values)}


def stat(key: str, label: str, value: Any, fmt: str, *, sub: Any = None, tone: str | None = None) -> dict[str, Any]:
    card: dict[str, Any] = {"key": key, "label": label, "value": grams(value) if fmt in MONEY_FORMATS else value, "format": fmt}
    if sub is not None:
        card["sub"] = sub
    if tone:
        card["tone"] = tone
    return card


def series(key: str, label: str, data: list[Any], style: str = "primary", **extra: Any) -> dict[str, Any]:
    return {"key": key, "label": label, "data": data, "style": style, **extra}


def chart(chart_id: str, kind: str, labels: list[str], datasets: list[dict[str, Any]], *, y_format: str = "money", **extra: Any) -> dict[str, Any]:
    if y_format in MONEY_FORMATS or extra.get("y2_format") in MONEY_FORMATS:
        for dataset in datasets:
            axis_format = extra.get("y2_format") if dataset.get("axis") == "y2" else y_format
            if axis_format in MONEY_FORMATS:
                dataset["data"] = [[grams(point[0]), grams(point[1])] if isinstance(point, list) else grams(point) for point in dataset["data"]]
    return {"id": chart_id, "kind": kind, "labels": labels, "datasets": datasets, "y_format": y_format, "ref_lines": extra.pop("ref_lines", []), **extra}


def column(key: str, label: str, fmt: str = "text", align: str | None = None) -> dict[str, Any]:
    entry = {"key": key, "label": label, "format": fmt}
    entry["align"] = align or ("left" if fmt in ("text", "date", "month") else "right")
    return entry


def table(
    table_id: str,
    columns: list[dict[str, Any]],
    rows: list[dict[str, Any]],
    *,
    title: str | None = None,
    total_row: dict[str, Any] | None = None,
    sortable: list[str] | None = None,
    sort: dict[str, str] | None = None,
    empty_text: str | None = None,
) -> dict[str, Any]:
    money_columns = {entry["key"] for entry in columns if entry["format"] in MONEY_FORMATS}
    for entry in [*rows, *([total_row] if total_row else [])]:
        for key in money_columns:
            if key in entry["cells"]:
                entry["cells"][key] = grams(entry["cells"][key])
    result: dict[str, Any] = {"id": table_id, "columns": columns, "rows": rows, "sortable": sortable or [], "sort": sort}
    if title:
        result["title"] = title
    if total_row:
        result["total_row"] = total_row
    if empty_text:
        result["empty_text"] = empty_text
    return result


def row(key: str, cells: dict[str, Any], *, tone: str | None = None, drill: dict[str, Any] | None = None) -> dict[str, Any]:
    entry: dict[str, Any] = {"key": key, "cells": cells}
    if tone:
        entry["tone"] = tone
    if drill:
        entry["drill"] = drill
    return entry


def variant_key(params: dict[str, Any], defaults: dict[str, Any]) -> str:
    """Parameters sorted by name, `name=value` joined by `&`, values percent-encoded; defaults left out."""
    parts = []
    for name in sorted(params):
        value = params[name]
        if value is None or value == "" or defaults.get(name) == value:
            continue
        parts.append(f"{name}={quote(str(value), safe='')}")
    return "&".join(parts)


def empty_payload(**fields: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "contract_version": CONTRACT_VERSION,
        "report_id": None,
        "predefined_key": None,
        "variant_key": "",
        "anchor_date": None,
        "title": "",
        "description": "",
        "period": None,
        "compare": None,
        "tab": None,
        "tabs": [],
        "controls": [],
        "stat_cards": [],
        "charts": [],
        "tables": [],
        "drill": None,
        "breadcrumbs": [],
        "notes": [],
        "empty": None,
        "warnings": [],
    }
    payload.update(fields)
    return payload


def _check_text(value: Any, where: str, problems: list[str]) -> None:
    if value is None or isinstance(value, str):
        return
    if not isinstance(value, dict) or not isinstance(value.get("text"), str) or not isinstance(value.get("values"), list):
        problems.append(f"{where}:text")
        return
    count = value["text"].count("{")
    if count != len(value["values"]):
        problems.append(f"{where}:placeholders")
    for item in value["values"]:
        if item.get("format") not in FORMATS:
            problems.append(f"{where}:format")


def _check_chart(item: dict[str, Any], where: str, problems: list[str]) -> None:
    if item.get("kind") not in CHART_KINDS:
        problems.append(f"{where}:kind")
    if item.get("y_format") not in FORMATS:
        problems.append(f"{where}:y_format")
    for dataset in item.get("datasets", []):
        if item.get("kind") not in ("donut", "pie", "gauge") and len(dataset.get("data", [])) != len(item.get("labels", [])):
            problems.append(f"{where}:data_length")


def _check_table(item: dict[str, Any], where: str, problems: list[str]) -> None:
    keys = {entry["key"] for entry in item.get("columns", [])}
    for entry in item.get("columns", []):
        if entry.get("format") not in FORMATS:
            problems.append(f"{where}:format")
    for entry in [*item.get("rows", []), *([item["total_row"]] if item.get("total_row") else [])]:
        if not set(entry.get("cells", {})) <= keys:
            problems.append(f"{where}:cells")
            break
        for key, value in entry["cells"].items():
            if isinstance(value, dict):
                _check_text(value, f"{where}.cells.{key}", problems)


def validate(payload: dict[str, Any]) -> list[str]:
    """Problems with a payload (empty = valid): shape, formats, chart kinds, text placeholders (cards, notes, cells, drill), JSON."""
    problems: list[str] = []
    for key in empty_payload():
        if key not in payload:
            problems.append(f"missing:{key}")
    for index, card in enumerate(payload.get("stat_cards", [])):
        if card.get("format") not in FORMATS:
            problems.append(f"stat_cards[{index}]:format")
        _check_text(card.get("sub"), f"stat_cards[{index}].sub", problems)
    for index, item in enumerate(payload.get("charts", [])):
        _check_chart(item, f"charts[{index}]", problems)
    for index, item in enumerate(payload.get("tables", [])):
        _check_table(item, f"tables[{index}]", problems)
    drill = payload.get("drill")
    if drill:
        _check_text(drill.get("title"), "drill.title", problems)
        _check_text(drill.get("subtitle"), "drill.subtitle", problems)
        for index, item in enumerate(drill.get("charts") or []):
            _check_chart(item, f"drill.charts[{index}]", problems)
        if drill.get("table"):
            _check_table(drill["table"], "drill.table", problems)
    for index, note in enumerate(payload.get("notes", [])):
        _check_text(note, f"notes[{index}]", problems)
    try:
        json.dumps(payload, allow_nan=False)
    except ValueError:
        problems.append("json:nan_or_infinity")
    return problems
