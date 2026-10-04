"""The cross-language payload fixture (contract/fixtures/payload-conversion.json).

One payload with money in every place the contract allows, built with core.payload, plus
the JSON paths of its money values found by this module's own reading of the rules
(report-payload.md, "Which values GAS converts"). The GAS read layer's test converts the
same file and checks that exactly these values change. Regenerate after a deliberate
change with: REGENERATE_FIXTURES=1 uv run pytest tests/unit/test_payload_fixture.py
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from core import payload as p

FIXTURE = Path(__file__).resolve().parents[2] / "contract" / "fixtures" / "payload-conversion.json"
MONEY = set(p.MONEY_FORMATS)


def sample() -> dict[str, Any]:
    sub = p.text("{0} vs {1} ({2})", p.money(1.5, "money_delta"), {"value": "2026-09", "format": "month"}, {"value": 12.5, "format": "percent_delta"})
    chart = p.chart(
        "mix",
        "mixed",
        ["Jan", "Feb"],
        [p.series("spend", "Spending", [1.25, None], "expense"), p.series("rate", "Rate", [10.0, 20.0], "compare", axis="y2")],
        y2_format="percent",
        ref_lines=[{"value": 2.0, "label": "Budget"}, {"value": 30.0, "label": "Target", "axis": "y2"}],
    )
    waterfall = p.chart("flow", "waterfall", ["Start", "In"], [p.series("steps", "Steps", [[0.0, 3.0], [3.0, 4.5]], "primary")])
    counts = p.chart("counts", "bar", ["A"], [p.series("n", "Count", [7], "primary")], y_format="count")
    table = p.table(
        "rows",
        [p.column("name", "Name"), p.column("amount", "Amount", "money"), p.column("local", "Local", "local"), p.column("share", "Share", "percent"), p.column("note", "Note")],
        [p.row("a", {"name": "Tesco", "amount": 2.5, "local": 250.0, "share": 40.0, "note": p.text("{0} a month", p.money(0.75))})],
        total_row={"cells": {"name": "Total", "amount": 2.5, "local": None, "share": 100.0}},
    )
    drill = {
        "title": p.text("Balances on {0}", {"value": "2026-09-30", "format": "date"}),
        "subtitle": p.text("{0} in total", p.money(9.0)),
        "charts": [p.chart("months", "bar", ["Sep"], [p.series("spend", "Spending", [4.0], "expense")])],
        "table": p.table("drill", [p.column("account", "Account"), p.column("value", "Value", "money2")], [p.row("x", {"account": "Bank", "value": 5.5})]),
    }
    return p.empty_payload(
        report_id="00000000-0000-0000-0000-000000000001",
        stat_cards=[p.stat("worth", "Net worth", 100.0, "money", sub=sub), p.stat("count", "Transactions", 42, "count"), p.stat("rate", "Savings rate", 12.5, "percent")],
        charts=[chart, waterfall, counts, p.chart("gauge", "gauge", [], [], y_format="percent", gauge={"value": 25.0, "max": 100})],
        tables=[table],
        notes=[p.text("Down {0}", p.money(0.5, "money_delta"))],
        drill=drill,
    )


def money_paths(payload: dict[str, Any]) -> list[str]:
    """Paths of the money numbers, by the rules in report-payload.md."""
    out: list[str] = []

    def text(value: Any, path: str) -> None:
        if isinstance(value, dict):
            for index, item in enumerate(value.get("values", [])):
                if item["format"] in MONEY and isinstance(item["value"], (int, float)):
                    out.append(f"{path}.values[{index}].value")

    def chart(item: dict[str, Any], path: str) -> None:
        def axis_format(axis: Any) -> str:
            return item.get("y2_format") if axis == "y2" else item["y_format"]

        for d, dataset in enumerate(item["datasets"]):
            if axis_format(dataset.get("axis")) in MONEY:
                for i, point in enumerate(dataset["data"]):
                    if isinstance(point, list):
                        out.extend(f"{path}.datasets[{d}].data[{i}][{j}]" for j, value in enumerate(point) if isinstance(value, (int, float)))
                    elif isinstance(point, (int, float)):
                        out.append(f"{path}.datasets[{d}].data[{i}]")
        for r, line in enumerate(item.get("ref_lines", [])):
            if axis_format(line.get("axis")) in MONEY:
                out.append(f"{path}.ref_lines[{r}].value")

    def table(item: dict[str, Any], path: str) -> None:
        formats = {column["key"]: column["format"] for column in item["columns"]}
        rows = [(f"{path}.rows[{index}]", row) for index, row in enumerate(item["rows"])]
        if item.get("total_row"):
            rows.append((f"{path}.total_row", item["total_row"]))
        for row_path, row in rows:
            for key, value in row["cells"].items():
                if isinstance(value, dict):
                    text(value, f"{row_path}.cells.{key}")
                elif formats.get(key) in MONEY and isinstance(value, (int, float)):
                    out.append(f"{row_path}.cells.{key}")

    for index, card in enumerate(payload["stat_cards"]):
        if card["format"] in MONEY and isinstance(card["value"], (int, float)):
            out.append(f"stat_cards[{index}].value")
        text(card.get("sub"), f"stat_cards[{index}].sub")
    for index, item in enumerate(payload["charts"]):
        chart(item, f"charts[{index}]")
    for index, item in enumerate(payload["tables"]):
        table(item, f"tables[{index}]")
    for index, note in enumerate(payload["notes"]):
        text(note, f"notes[{index}]")
    drill = payload.get("drill")
    if drill:
        text(drill.get("title"), "drill.title")
        text(drill.get("subtitle"), "drill.subtitle")
        for index, item in enumerate(drill.get("charts", [])):
            chart(item, f"drill.charts[{index}]")
        if drill.get("table"):
            table(drill["table"], "drill.table")
    return out


def test_the_fixture_matches_the_builders_and_the_rules() -> None:
    payload = sample()
    assert p.validate(payload) == []
    expected = {"_comment": __doc__.strip().splitlines()[0], "payload": payload, "money_paths": money_paths(payload)}
    text = json.dumps(expected, indent=1, ensure_ascii=False) + "\n"
    if os.environ.get("REGENERATE_FIXTURES") == "1":
        FIXTURE.write_text(text)
    assert FIXTURE.read_text() == text, "regenerate with REGENERATE_FIXTURES=1"
    assert len(expected["money_paths"]) == 15
