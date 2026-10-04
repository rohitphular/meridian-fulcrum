"""Place names: the single country normalisation used by reports and filters.

Taken over from the app (expense-tracker insights COUNTRY_NORM / CURRENCY_COUNTRY), so a
country report and a user report filtered by country agree.
"""

from __future__ import annotations

UNKNOWN = "Unknown"

_COUNTRY_ALIASES = {
    "uk": "United Kingdom",
    "gb": "United Kingdom",
    "england": "United Kingdom",
    "us": "United States",
    "usa": "United States",
    "america": "United States",
    "uae": "UAE",
    "in": "India",
}

# Home country of a currency: decides "home" vs "abroad" (spend by city).
CURRENCY_COUNTRY = {
    "GBP": "United Kingdom",
    "USD": "United States",
    "INR": "India",
    "AUD": "Australia",
    "CAD": "Canada",
    "CHF": "Switzerland",
    "SGD": "Singapore",
    "HKD": "Hong Kong",
    "JPY": "Japan",
    "NZD": "New Zealand",
}


def country(value: str | None) -> str:
    text = (value or "").strip()
    if text == "":
        return UNKNOWN
    return _COUNTRY_ALIASES.get(text.lower(), text)


def city(value: str | None) -> str:
    text = (value or "").strip()
    return text if text else UNKNOWN
