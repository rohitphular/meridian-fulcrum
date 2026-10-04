"""Build step: every pre-built report, every variant, into analytics.report_output.

Variants come from the catalogue: each period × tab × control value, plus the aggregate
drills an implementation lists (computed for the default tab and controls of each period;
the reader ignores non-default controls when a drill is requested). A report that fails is
recorded as failed with a code and counted; it never fails the run.
"""

from __future__ import annotations

import itertools
import json
import time
from typing import Any

from psycopg2.extras import execute_values
from py_logging import get_logger

import core.config as config
from core import payload, periods
from core.context import BuildContext
from core.errors import error_code
from core.reports import DRILLS, REGISTRY, load_all
from core.reports.context import ReportContext

logger = get_logger(__name__)


def _defaults(entry: dict[str, Any]) -> dict[str, Any]:
    defaults: dict[str, Any] = {"period": entry["default_period"], "tab": entry["tabs"][0]["key"] if entry["tabs"] else None}
    for control in entry["controls"]:
        defaults[control["param"]] = control["default"]
    return defaults


def variants(entry: dict[str, Any]) -> list[dict[str, Any]]:
    """The base variants (no drill) of a catalogue entry, the default first."""
    period_keys = entry["periods"] or [entry["default_period"]]
    tab_keys = [tab["key"] for tab in entry["tabs"]] or [None]
    control_values = [[(control["param"], value) for value in control["values"]] for control in entry["controls"]]
    out = []
    for period_key, tab_key, *chosen in itertools.product(period_keys, tab_keys, *control_values):
        out.append({"period": period_key, "tab": tab_key, **dict(chosen)})
    defaults = _defaults(entry)
    out.sort(key=lambda params: params != defaults)
    return out


def _drill(value: str) -> dict[str, str]:
    """'param:value' → {param: value} (the value may itself contain ':')."""
    name, _, item = value.partition(":")
    return {name: item}


def _settings() -> tuple[str, str]:
    settings = config.load_config()
    return settings.get("home_country", "United Kingdom"), settings.get("home_currency", "GBP")


def _payload(entry: dict[str, Any], context: ReportContext, params: dict[str, Any]) -> dict[str, Any]:
    body = REGISTRY[entry["key"]](context)
    defaults = _defaults(entry)
    tabs = [{"key": tab["key"], "label": tab["label"], "active": tab["key"] == context.tab} for tab in entry["tabs"]]
    controls = [
        {
            "param": control["param"],
            "label": control.get("label"),
            "value": context.controls[control["param"]],
            "options": [{"value": value, "label": f"{value}d" if control["param"] == "window" else f"Top {value}"} for value in control["values"]],
        }
        for control in entry["controls"]
    ]
    result = payload.empty_payload(
        report_id=entry["id"],
        predefined_key=entry["key"],
        variant_key=payload.variant_key(params, defaults),
        anchor_date=context.anchor.isoformat(),
        title=entry["title"],
        description=entry["description"],
        period=context.period.as_payload() if context.period else None,
        compare=None if context.compare is None else {"mode": "previous", "from": context.compare.start.isoformat(), "to": context.compare.end.isoformat(), "label": context.compare.label},
        tab=context.tab,
        tabs=tabs,
        controls=controls,
    )
    result.update(body)
    missing = sorted(context.mart.missing_currencies)
    if missing and not any(item.get("code") == "missing_rate" for item in result["warnings"]):
        result["warnings"].append({"code": "missing_rate", "currencies": missing})
    problems = payload.validate(result)
    if problems:
        raise ValueError(f"invalid_payload:{problems[0]}")
    return result


def build_entry(entry: dict[str, Any], context: BuildContext, home: tuple[str, str]) -> list[tuple[str, dict[str, Any]]]:
    """(variant_key, payload) for every variant of one pre-built report."""
    out = []
    mart = context.mart
    for params in variants(entry):
        period = None if params["period"] is None else periods.resolve(params["period"], context.anchor_date)
        controls = {control["param"]: params[control["param"]] for control in entry["controls"]}
        report_context = ReportContext(mart, context.anchor_date, entry, period, periods.compared(period, "previous") if period else None, params["tab"], controls, None, home[0], home[1], params)
        result = _payload(entry, report_context, params)
        out.append((result["variant_key"], result))
        default_controls = all(params[control["param"]] == control["default"] for control in entry["controls"])
        if entry["key"] in DRILLS and default_controls and params["tab"] == _defaults(entry)["tab"]:
            for value in DRILLS[entry["key"]](report_context):
                drill_params = {**params, "drill": value}
                drill_context = ReportContext(mart, context.anchor_date, entry, period, report_context.compare, params["tab"], controls, _drill(value), home[0], home[1], drill_params)
                result = _payload(entry, drill_context, drill_params)
                out.append((result["variant_key"], result))
    return out


def step(conn: Any, context: BuildContext) -> None:
    load_all()
    home = _settings()
    catalogue = config.contract("predefined-reports")["reports"]
    rows: list[tuple[str, str, str, str]] = []
    results: list[tuple[str, str, str, str, str | None]] = []
    largest = 0
    for entry in catalogue:
        started = time.monotonic()
        if entry["key"] not in REGISTRY:
            results.append((context.generation_id, entry["id"], "", "failed", "report_not_implemented"))
            context.reports_failed += 1
            continue
        try:
            built = build_entry(entry, context, home)
        except Exception as error:  # one report must not fail the run
            code = error_code(error)
            logger.warning(f"predefined: report={entry['key']} failed=true error={type(error).__name__} reason={code[:120]}")
            results.append((context.generation_id, entry["id"], "", "failed", code[:200]))
            context.reports_failed += 1
            continue
        for variant, body in built:
            text = json.dumps(body, separators=(",", ":"), allow_nan=False)
            largest = max(largest, len(text))
            rows.append((context.generation_id, entry["id"], variant, text))
        results.append((context.generation_id, entry["id"], "", "ready", None))
        context.reports_ok += 1
        logger.info(f"predefined: report={entry['key']} variants={len(built)} seconds={time.monotonic() - started:.2f}")
    with conn.cursor() as cursor:
        if rows:
            execute_values(cursor, "INSERT INTO analytics.report_output (generation_id, report_id, variant_key, payload) VALUES %s", rows, template="(%s, %s, %s, %s::jsonb)")
        execute_values(cursor, "INSERT INTO analytics.report_result (generation_id, report_id, definition_updated_at, status, error_code) VALUES %s", results)
    total_chars = sum(len(item[3]) for item in rows)
    logger.info(f"predefined: reports={len(results)} payloads={len(rows)} total_chars={total_chars} largest_chars={largest}")
