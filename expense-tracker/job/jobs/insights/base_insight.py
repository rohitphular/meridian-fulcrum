from abc import ABC, abstractmethod


class BaseInsight(ABC):
    insight_id: str  = ''
    periods: list      = ['default']
    derived_from: list = ['default']
    chart_variants: list = ['']

    def __init__(self, rate_map: dict, quote_currency: str):
        self.rate_map       = rate_map
        self.quote_currency = quote_currency

    @abstractmethod
    def compute(self, raw: dict, from_date, to_date, derived_from: str, variant: str) -> dict:
        """Return { stat_cards, chart, meta } payload dict."""
        raise NotImplementedError
