from datetime import date

from jobs.insights.base_insight import BaseInsight
from jobs.insights.data_utils import (
    currency_symbol, filter_by_range, sum_amount_base,
    is_active_account, build_monthly_cumulative,
    sample_month_end_assets, TEAL, AMBER, MONTH_ABBREV,
)
from jobs.insights.insight_schema import TxField, AccountField, TX_TYPE_MONEY_OUT


def _fmt(v, sym):
    return f'{sym}{abs(v):,.0f}'


def _change_card(total_a, total_b, sym, label='YoY change', positive_when_down=True):
    delta = total_a - total_b
    pct   = round(abs(delta) / abs(total_b) * 100) if total_b else None
    pcts  = f' ({pct}%)' if pct is not None else ''
    arrow = '↓' if delta <= 0 else '↑'
    good  = (delta <= 0) == positive_when_down
    return {'label': label, 'value': f'{arrow} {_fmt(abs(delta), sym)}{pcts}', 'sub': '', 'class': 'positive' if good else 'negative'}


class D05YtdComparison(BaseInsight):
    insight_id     = '05-ytd-comparison'
    periods        = ['ytd', 'last_year']
    derived_from   = ['transactions', 'accounts']
    chart_variants = ['']

    def compute(self, raw, from_date, to_date, derived_from, variant):
        today    = date.today()
        sym      = currency_symbol(self.quote_currency)
        all_txs  = raw['transactions']
        accounts = raw['accounts']

        year_a  = from_date.year
        year_b  = year_a - 1
        is_cy   = today.year == year_a
        a_end   = min(to_date, today) if is_cy else to_date
        num_mon = a_end.month

        b_from = date(year_b, 1, 1)
        b_end  = date(year_b, a_end.month, a_end.day)

        labels  = [MONTH_ABBREV[m] for m in range(num_mon)]
        label_a = f'{year_a} YTD' if is_cy else str(year_a)
        label_b = f'{year_b} (same period)' if is_cy else str(year_b)

        if derived_from == 'transactions':
            return self._transactions(all_txs, year_a, year_b, a_end, b_end,
                                      num_mon, is_cy, labels, label_a, label_b, sym)
        return self._accounts(accounts, all_txs, from_date, a_end, b_from, b_end,
                               num_mon, is_cy, labels, label_a, label_b, sym)

    def _transactions(self, all_txs, year_a, year_b, a_end, b_end,
                      num_mon, is_cy, labels, label_a, label_b, sym):
        a_start = date(year_a, 1, 1)
        b_start = date(year_b, 1, 1)

        money_out_a = [tx for tx in filter_by_range(all_txs, a_start, a_end)
                       if tx.get(TxField.TYPE) == TX_TYPE_MONEY_OUT]
        money_out_b = [tx for tx in filter_by_range(all_txs, b_start, b_end)
                       if tx.get(TxField.TYPE) == TX_TYPE_MONEY_OUT]

        data_a = build_monthly_cumulative(money_out_a, year_a, num_mon,
                                          a_end if is_cy else None,
                                          self.rate_map, self.quote_currency)
        data_b = build_monthly_cumulative(money_out_b, year_b, num_mon, None,
                                          self.rate_map, self.quote_currency)

        total_a = data_a[-1] if data_a else 0.0
        total_b = data_b[-1] if data_b else 0.0

        return {
            'stat_cards': [
                {'label': label_a, 'value': _fmt(total_a, sym), 'sub': '', 'class': ''},
                {'label': label_b, 'value': _fmt(total_b, sym), 'sub': '', 'class': ''},
                _change_card(total_a, total_b, sym, positive_when_down=True),
                {'label': 'Months', 'value': str(num_mon), 'sub': 'of 12', 'class': ''},
            ],
            'chart': {
                'labels': labels,
                'datasets': [
                    {'label': label_a, 'data': data_a, 'borderColor': TEAL},
                    {'label': label_b, 'data': data_b, 'borderColor': AMBER},
                ],
            },
            'meta': {'from': f'{year_a}-01-01', 'to': a_end.isoformat(), 'currency': self.quote_currency},
        }

    def _accounts(self, accounts, all_txs, a_from, a_end, b_from, b_end,
                  num_mon, is_cy, labels, label_a, label_b, sym):
        asset_accts = [a for a in accounts if is_active_account(a) and a.get(AccountField.TYPE) != 'liability']
        if not asset_accts:
            return {'stat_cards': [], 'chart': None,
                    'meta': {'from': a_from.isoformat(), 'to': a_end.isoformat(), 'currency': self.quote_currency}}

        data_a = sample_month_end_assets(asset_accts, all_txs, a_from, a_end,
                                         num_mon, is_cy, self.rate_map, self.quote_currency)
        data_b = sample_month_end_assets(asset_accts, all_txs, b_from, b_end,
                                         num_mon, False, self.rate_map, self.quote_currency)

        latest_a = data_a[-1] if data_a else 0.0
        latest_b = data_b[-1] if data_b else 0.0

        return {
            'stat_cards': [
                {'label': f'Assets {label_a}', 'value': _fmt(latest_a, sym), 'sub': '', 'class': ''},
                {'label': f'Assets {label_b}', 'value': _fmt(latest_b, sym), 'sub': '', 'class': ''},
                _change_card(latest_a, latest_b, sym, positive_when_down=False),
                {'label': 'Months', 'value': str(num_mon), 'sub': 'of 12', 'class': ''},
            ],
            'chart': {
                'labels': labels,
                'datasets': [
                    {'label': f'Assets {label_a}', 'data': data_a, 'borderColor': TEAL},
                    {'label': f'Assets {label_b}', 'data': data_b, 'borderColor': AMBER},
                ],
            },
            'meta': {'from': a_from.isoformat(), 'to': a_end.isoformat(), 'currency': self.quote_currency},
        }
