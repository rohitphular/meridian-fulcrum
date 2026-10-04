"""Writes the seed CSVs for a new data folder from the contract:

    seed/report_master.csv     every pre-built report row (locked, fixed UUID)
    seed/dashboard_layout.csv  the default Home layout

Copy both into the ledger-sheet-load data folder once (they are part of its CSV round
trip); afterwards the app's exports keep them current. Re-run after a contract change:

    python3 data-synchronization/analytics/contract/generate_seed.py          # write
    python3 data-synchronization/analytics/contract/generate_seed.py --check  # fail if out of date

Standard library only.
"""

from __future__ import annotations

import csv
import io
import json
import sys
from pathlib import Path

CONTRACT_DIR = Path(__file__).resolve().parent
SEED_DIR = CONTRACT_DIR / "seed"


def _csv(columns: list[str], rows: list[dict[str, str]]) -> str:
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=columns, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return buffer.getvalue()


def render() -> dict[str, str]:
    definition = json.loads((CONTRACT_DIR / "report-definition.json").read_text())
    catalogue = json.loads((CONTRACT_DIR / "predefined-reports.json").read_text())
    tabs = json.loads((CONTRACT_DIR / "sheet-tabs.json").read_text())
    name_max = definition["name"]["max_length"]
    description_max = definition["description"]["max_length"]
    reports = [
        {
            "id": report["id"],
            "report_type": "predefined",
            "predefined_key": report["key"],
            "report_name": report["title"][:name_max],
            "report_description": report["description"][:description_max],
            "record_status": definition["predefined_record_status"],
        }
        for report in catalogue["reports"]
    ]
    by_key = {report["key"]: report["id"] for report in catalogue["reports"]}
    layout_tab = next(tab for tab in tabs["tabs"] if tab["name"] == "dashboard_layout")
    layout = catalogue["default_layout"]
    slots = []
    for slot in layout_tab["slots"]:
        area, number = slot.split("_")
        keys = layout["tiles"] if area == "tile" else layout["panels"]
        slots.append({"slot": slot, "report_id": by_key[keys[int(number) - 1]]})
    return {
        "report_master.csv": _csv(definition["csv_columns"], [{column: row.get(column, "") for column in definition["csv_columns"]} for row in reports]),
        "dashboard_layout.csv": _csv(layout_tab["csv_columns"], slots),
    }


def main() -> None:
    files = render()
    if "--check" in sys.argv[1:]:
        stale = [name for name, text in files.items() if not (SEED_DIR / name).is_file() or (SEED_DIR / name).read_text() != text]
        if stale:
            raise SystemExit(f"out of date: {', '.join(stale)}; run generate_seed.py")
        print("seed files are up to date")
        return
    SEED_DIR.mkdir(exist_ok=True)
    for name, text in files.items():
        (SEED_DIR / name).write_text(text)
        print(f"wrote {SEED_DIR / name}")


if __name__ == "__main__":
    main()
