from __future__ import annotations

import csv
from datetime import date
from pathlib import Path


def load_csv(filepath: Path) -> dict[date, float]:
    """Parse a pre-downloaded stooq CSV into {date: close_price_per_troy_oz}.

    Download URL:
      https://stooq.com/q/d/l/?s=xauusd&d1=20200101&d2=20251231&i=d
    CSV columns: Date, Open, High, Low, Close, Volume
    """
    rows: dict[date, float] = {}
    with filepath.open() as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                rate_date = date.fromisoformat(row["Date"])
                close = float(row["Close"])
                rows[rate_date] = close
            except (KeyError, ValueError):
                continue
    return rows


def fetch_csv_row(rate_date: date, data: dict[date, float] | None = None) -> float | None:
    """Return the close price (per troy oz) for a given date, or None if not available."""
    if data is None:
        return None
    return data.get(rate_date)
