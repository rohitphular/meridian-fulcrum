"""Validate one staged report_master row against the report contract.

Mirrors expense-tracker/api/report-validation.gs (validateReportDefinition) rule for rule,
so a definition the app saved is accepted here, and a hand edit in the Sheet that breaks a
rule fails with the same code. Errors are ValueError("reports: <code>:<column>"); the code
and column become the row's sync_notes.

refs: the accounts, categories and currencies filters may point at, from PostgreSQL
(non-deleted rows), or None to check the format only (e.g. for deleted reports).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal
from typing import Any
from uuid import UUID

from core import report_contract

_AMOUNT = re.compile(r"^\d+(?:\.\d+)?$")
_CURRENCY = re.compile(r"^[A-Z0-9]{1,8}$")
_DATE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
_TEXT_VALUE_MAX = 100
_SHEETS_EPOCH = date(1899, 12, 30)
_STATUSES = ("active", "inactive", "deleted", "locked")


@dataclass(frozen=True)
class References:
    account_ids: frozenset[str] = field(default_factory=frozenset)
    categories: frozenset[str] = field(default_factory=frozenset)
    currencies: frozenset[str] = field(default_factory=frozenset)


def _fail(code: str, column: str) -> ValueError:
    return ValueError(f"reports: {code}:{column}")


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def _choice(items: list[dict[str, Any]], key: str) -> dict[str, Any] | None:
    return next((item for item in items if item["key"] == key), None)


def _date(value: Any) -> date | None:
    """YYYY-MM-DD text, or a Sheets date serial (a date cell read unformatted)."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return _SHEETS_EPOCH + timedelta(days=int(value))
    match = _DATE.match(_text(value))
    if match is None:
        return None
    try:
        return date(int(match[1]), int(match[2]), int(match[3]))
    except ValueError:
        return None


def _boolean(value: Any, default: bool) -> bool | None:
    if isinstance(value, bool):
        return value
    text = _text(value).lower()
    if text == "":
        return default
    return {"true": True, "false": False}.get(text)


def _list(value: Any, case_insensitive: bool) -> list[str]:
    separator = report_contract.definition()["filter_rules"]["list_separator"]
    seen: set[str] = set()
    out: list[str] = []
    for part in _text(value).split(separator):
        item = part.strip()
        key = item.lower() if case_insensitive else item
        if item == "" or key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out


def _filter(spec: dict[str, Any], raw: Any, refs: References | None) -> list[str] | Decimal | None:
    column = spec["column"]
    kind = spec["value_type"]
    if kind == "amount":
        text = _text(raw)
        if text == "":
            return None
        if not _AMOUNT.match(text):
            raise _fail("invalid_filter_value", column)
        return Decimal(text)
    values = _list(raw, kind in ("text_list", "uuid_list", "currency_list"))
    if len(values) > spec["max_values"]:
        raise _fail("too_many_filter_values", column)
    out: list[str] = []
    for item in values:
        if kind == "uuid_list":
            try:
                identity = str(UUID(item))
            except ValueError as error:
                raise _fail("invalid_filter_value", column) from error
            if item.lower() != identity:
                raise _fail("invalid_filter_value", column)
            if refs is not None and identity not in refs.account_ids:
                raise _fail("unknown_filter_reference", column)
            out.append(identity)
        elif kind == "category_list":
            parts = [part.strip() for part in item.split("|")]
            if len(parts) > 2 or any(part == "" for part in parts):
                raise _fail("invalid_filter_value", column)
            key = "|".join(parts)
            if refs is not None and key not in refs.categories:
                raise _fail("unknown_filter_reference", column)
            out.append(key)
        elif kind == "currency_list":
            code = item.upper()
            if not _CURRENCY.match(code):
                raise _fail("invalid_filter_value", column)
            if refs is not None and code not in refs.currencies:
                raise _fail("unknown_filter_reference", column)
            out.append(code)
        elif kind == "tx_type_list":
            if item not in spec["values"]:
                raise _fail("invalid_filter_value", column)
            out.append(item)
        else:
            if len(item) > _TEXT_VALUE_MAX:
                raise _fail("invalid_filter_value", column)
            out.append(item)
    return out


def _chart_error(chart: dict[str, Any], measure: dict[str, Any], grain: str, group_count: int) -> str:
    measures = chart["measures"]
    measure_ok = measures == "all" or (measures == "additive" and measure["additive"]) or (isinstance(measures, list) and measure["key"] in measures)
    if not measure_ok:
        return "chart_not_allowed_for_measure"
    for mode in chart["modes"]:
        grain_ok = mode["time_grain"] == "any" or (mode["time_grain"] == "required") == (grain != "none")
        if grain_ok and mode["group_by_min"] <= group_count <= mode["group_by_max"]:
            return ""
    return "chart_not_allowed_for_shape"


def validate_definition(row: dict[str, Any], refs: References | None) -> dict[str, Any]:
    """The user-defined part of a row → typed values (lists as lists, dates as date)."""
    spec = report_contract.definition()
    values: dict[str, Any] = {}

    name = _text(row.get("report_name"))
    if name == "":
        raise _fail("missing_report_name", "report_name")
    if len(name) < spec["name"]["min_length"]:
        raise _fail("report_name_too_short", "report_name")
    if len(name) > spec["name"]["max_length"]:
        raise _fail("report_name_too_long", "report_name")
    values["report_name"] = name
    description = _text(row.get("report_description"))
    if len(description) > spec["description"]["max_length"]:
        raise _fail("report_description_too_long", "report_description")
    values["report_description"] = description

    measure = _choice(spec["measures"], _text(row.get("measure")))
    if measure is None:
        raise _fail("invalid_measure", "measure")
    values["measure"] = measure["key"]

    preset = _choice(spec["period_presets"], _text(row.get("period_preset")))
    if preset is None:
        raise _fail("invalid_period_preset", "period_preset")
    values["period_preset"] = preset["key"]
    span_days = preset["max_days"]
    raw_from, raw_to = row.get("period_from"), row.get("period_to")
    if preset["key"] == "fixed":
        start, end = _date(raw_from), _date(raw_to)
        if start is None:
            raise _fail("invalid_period_dates", "period_from")
        if end is None or end < start:
            raise _fail("invalid_period_dates", "period_to")
        span_days = (end - start).days + 1
        if span_days > spec["limits"]["fixed_period_max_days"]:
            raise _fail("fixed_period_too_long", "period_to")
        values["period_from"], values["period_to"] = start, end
    elif _text(raw_from) != "" or _text(raw_to) != "":
        raise _fail("period_dates_not_allowed", "period_from" if _text(raw_from) != "" else "period_to")
    else:
        values["period_from"] = values["period_to"] = None

    compare = _choice(spec["compare_modes"], _text(row.get("compare_mode")) or "none")
    if compare is None:
        raise _fail("invalid_compare_mode", "compare_mode")
    if compare["key"] != "none" and preset["key"] in spec["compare_rules"]["not_with_periods"]:
        raise _fail("compare_not_allowed", "compare_mode")
    values["compare_mode"] = compare["key"]

    grain = _choice(spec["time_grains"], _text(row.get("time_grain")) or "none")
    if grain is None:
        raise _fail("invalid_time_grain", "time_grain")
    values["time_grain"] = grain["key"]

    groups = [_text(row.get("group_by_1")), _text(row.get("group_by_2"))]
    if groups[0] == "" and groups[1] != "":
        raise _fail("group_by_order", "group_by_2")
    for index, key in enumerate(groups, start=1):
        if key == "":
            continue
        if _choice(spec["group_by"], key) is None:
            raise _fail("invalid_group_by", f"group_by_{index}")
        if measure["group_by"] != "all" and key not in measure["group_by"]:
            raise _fail("group_by_not_allowed_for_measure", f"group_by_{index}")
    if groups[1] != "" and groups[0] == groups[1]:
        raise _fail("duplicate_group_by", "group_by_2")
    values["group_by_1"] = groups[0] or None
    values["group_by_2"] = groups[1] or None
    group_count = sum(1 for key in groups if key != "")

    rules = spec["group_by_rules"]
    top_text = _text(row.get("top_n"))
    include_other = _boolean(row.get("include_other"), rules["include_other_default"] if group_count > 0 else False)
    if include_other is None:
        raise _fail("invalid_include_other", "include_other")
    if group_count == 0:
        if top_text != "":
            raise _fail("top_n_without_group_by", "top_n")
        if include_other:
            raise _fail("top_n_without_group_by", "include_other")
        values["top_n"], values["include_other"] = None, False
    else:
        top = rules["top_n_default"] if top_text == "" else int(top_text) if top_text.isdigit() else None
        if top not in rules["top_n_values"]:
            raise _fail("invalid_top_n", "top_n")
        values["top_n"], values["include_other"] = top, include_other

    for spec_filter in spec["filters"]:
        parsed = _filter(spec_filter, row.get(spec_filter["column"]), refs)
        if parsed not in (None, []) and measure["kind"] == "stock" and spec_filter["key"] in spec["filter_rules"]["transaction_only"]:
            raise _fail("filter_not_allowed_for_measure", spec_filter["column"])
        values[spec_filter["column"]] = parsed
    if values["filter_amount_min"] is not None and values["filter_amount_max"] is not None and values["filter_amount_min"] > values["filter_amount_max"]:
        raise _fail("invalid_amount_range", "filter_amount_max")

    chart = _choice(spec["chart_kinds"], _text(row.get("chart_kind")))
    if chart is None:
        raise _fail("invalid_chart_kind", "chart_kind")
    error = _chart_error(chart, measure, grain["key"], group_count)
    if error:
        raise _fail(error, "chart_kind")
    values["chart_kind"] = chart["key"]

    if grain["key"] != "none" and span_days is not None and -(-span_days // spec["time_grain_days"][grain["key"]]) > spec["limits"]["max_points"]:
        raise _fail("too_many_points", "time_grain")
    return values


def transform(row: dict[str, Any], refs: References | None) -> dict[str, Any]:
    """A staged row → the report_master record. Pre-built rows take name and description
    from the catalogue and carry no definition; deleted rows skip the reference checks."""
    try:
        identity = str(UUID(_text(row.get("id"))))
    except ValueError as error:
        raise _fail("invalid_id", "id") from error
    report_type = _text(row.get("report_type")) or "user_defined"
    if _choice(report_contract.definition()["report_types"], report_type) is None:
        raise _fail("invalid_report_type", "report_type")
    status = _text(row.get("record_status")) or "active"
    if status not in _STATUSES:
        raise _fail("invalid_record_status", "record_status")
    typed: dict[str, Any] = {"id": identity, "report_type": report_type, "record_status": status, "source_created_at": _text(row.get("created_at")), "source_updated_at": _text(row.get("updated_at"))}
    if report_type == "predefined":
        key = _text(row.get("predefined_key"))
        entry = next((report for report in report_contract.predefined()["reports"] if report["key"] == key), None)
        if entry is None:
            raise _fail("invalid_predefined_key", "predefined_key")
        if entry["id"] != identity:
            raise _fail("invalid_predefined_key", "id")
        spec = report_contract.definition()
        typed.update({column: None for column in report_contract.columns() if column.startswith(("measure", "period_", "compare_", "time_", "group_", "top_", "include_", "chart_", "filter_"))})
        typed.update(
            {
                "predefined_key": key,
                "report_name": entry["title"][: spec["name"]["max_length"]],
                "report_description": entry["description"][: spec["description"]["max_length"]],
                "record_status": spec["predefined_record_status"],
            }
        )
        for spec_filter in spec["filters"]:
            typed[spec_filter["column"]] = None if spec_filter["value_type"] == "amount" else []
        return typed
    if _text(row.get("predefined_key")) != "":
        raise _fail("invalid_predefined_key", "predefined_key")
    typed["predefined_key"] = None
    typed.update(validate_definition(row, None if status == "deleted" else refs))
    return typed
