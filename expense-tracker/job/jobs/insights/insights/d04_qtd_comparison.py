from datetime import date, timedelta

from jobs.insights.base_insight import BaseInsight
from jobs.insights.data_utils import (
    currency_symbol, filter_by_range, sum_amount_base,
    compute_daily_total_assets, is_active_account,
    build_cumulative, last_non_null, TEAL, AMBER,
)
from jobs.insights.insight_schema import TxField, AccountField, TX_TYPE_MONEY_OUT


def _fmt(v, sym):
    return f'{sym}{abs(v):,.0f}'


def _quarter_label(first_day):
    q = (first_day.month - 1) // 3 + 1
    return f'Q{q} {first_day.year}'


def _prev_quarter_start(from_date):
    m = from_date.month - 3
    y = from_date.year
    if m <= 0:
        m += 12
        y -= 1
    return date(y, m, 1)


class D04QtdComparison(BaseInsight):
    insight_id     = '04-qtd-comparison'
    periods        = ['this_quarter', 'last_quarter']
    derived_from   = ['transactions', 'accounts']
    chart_variants = ['']

    def compute(self, raw, from_date, to_date, derived_from, variant):
        today    = date.today()
        sym      = currency_symbol(self.quote_currency)
        all_txs  = raw['transactions']
        accounts = raw['accounts']

        is_current_q   = from_date <= today <= to_date
        a_end          = min(to_date, today) if is_current_q else to_date
        days_elapsed   = (a_end - from_date).days + 1
        days_in_quarter = (to_date - from_date).days + 1

        b_from = _prev_quarter_start(from_date)
        b_to   = b_from + timedelta(days=days_elapsed - 1)

        labels    = [f'Day {d}' for d in range(1, days_elapsed + 1)]
        label_a   = _quarter_label(from_date) + (' (to date)' if is_current_q else '')
        label_b   = _quarter_label(b_from) + ' (same days)'

        if derived_from == 'transactions':
            return self._transactions(all_txs, from_date, a_end, b_from, b_to,
                                      days_elapsed, days_in_quarter, labels, label_a, label_b, sym)
        return self._accounts(accounts, all_txs, from_date, a_end, b_from, b_to,
                               days_elapsed, days_in_quarter, labels, label_a, label_b, sym)

    def _transactions(self, all_txs, a_from, a_end, b_from, b_to,
                      days_elapsed, days_in_quarter, labels, label_a, label_b, sym):
        money_out_a = [tx for tx in filter_by_range(all_txs, a_from, a_end)
                       if tx.get(TxField.TYPE) == TX_TYPE_MONEY_OUT]
        money_out_b = [tx for tx in filter_by_range(all_txs, b_from, b_to)
                       if tx.get(TxField.TYPE) == TX_TYPE_MONEY_OUT]

        data_a = build_cumulative(money_out_a, a_from, days_elapsed, None, self.rate_map, self.quote_currency)
        data_b = build_cumulative(money_out_b, b_from, days_elapsed, None, self.rate_map, self.quote_currency)

        total_a = data_a[-1] or 0.0 if data_a else 0.0
        total_b = data_b[-1] or 0.0 if data_b else 0.0
        delta   = total_a - total_b
        pct     = round(abs(delta) / abs(total_b) * 100) if total_b else None
        pcts    = f' ({pct}%)' if pct is not None else ''
        arrow   = '↓' if delta <= 0 else '↑'

        return {
            'stat_cards': [
                {'label': label_a, 'value': _fmt(total_a, sym), 'sub': '', 'class': ''},
                {'label': label_b, 'value': _fmt(total_b, sym), 'sub': '', 'class': ''},
                {'label': 'QTD change', 'value': f'{arrow} {_fmt(abs(delta), sym)}{pcts}', 'sub': '',
                 'class': 'positive' if delta <= 0 else 'negative'},
                {'label': 'Days in', 'value': str(days_elapsed), 'sub': f'of {days_in_quarter} days', 'class': ''},
            ],
            'chart': {
                'labels': labels,
                'datasets': [
                    {'label': label_a, 'data': data_a, 'borderColor': TEAL},
                    {'label': label_b, 'data': data_b, 'borderColor': AMBER},
                ],
            },
            'meta': {'from': a_from.isoformat(), 'to': a_end.isoformat(), 'currency': self.quote_currency,
                     'days_elapsed': days_elapsed, 'days_in_quarter': days_in_quarter},
        }

    def _accounts(self, accounts, all_txs, a_from, a_end, b_from, b_to,
                  days_elapsed, days_in_quarter, labels, label_a, label_b, sym):
        asset_accts = [a for a in accounts if is_active_account(a) and a.get(AccountField.TYPE) != 'liability']
        if not asset_accts:
            return {'stat_cards': [], 'chart': None,
                    'meta': {'from': a_from.isoformat(), 'to': a_end.isoformat(), 'currency': self.quote_currency}}

        daily_a = compute_daily_total_assets(asset_accts, all_txs, a_from, a_end, self.rate_map, self.quote_currency)
        daily_b = compute_daily_total_assets(asset_accts, all_txs, b_from, b_to,  self.rate_map, self.quote_currency)

        # Pad both to days_elapsed
        while len(daily_a) < days_elapsed: daily_a.append(daily_a[-1] if daily_a else 0.0)
        while len(daily_b) < days_elapsed: daily_b.append(daily_b[-1] if daily_b else 0.0)

        latest_a = daily_a[-1] if daily_a else 0.0
        latest_b = daily_b[-1] if daily_b else 0.0
        delta    = latest_a - latest_b
        pct      = round(abs(delta) / abs(latest_b) * 100) if latest_b else None
        pcts     = f' ({pct}%)' if pct is not None else ''
        arrow    = '↑' if delta >= 0 else '↓'

        return {
            'stat_cards': [
                {'label': 'Current assets',  'value': _fmt(latest_a, sym), 'sub': '', 'class': ''},
                {'label': label_b,           'value': _fmt(latest_b, sym), 'sub': '', 'class': ''},
                {'label': 'QTD change', 'value': f'{arrow} {_fmt(abs(delta), sym)}{pcts}', 'sub': '',
                 'class': 'positive' if delta >= 0 else 'negative'},
                {'label': 'Days in', 'value': str(days_elapsed), 'sub': f'of {days_in_quarter} days', 'class': ''},
            ],
            'chart': {
                'labels': labels,
                'datasets': [
                    {'label': f'Assets {label_a}', 'data': [round(v, 2) for v in daily_a], 'borderColor': TEAL},
                    {'label': f'Assets {label_b}', 'data': [round(v, 2) for v in daily_b], 'borderColor': AMBER},
                ],
            },
            'meta': {'from': a_from.isoformat(), 'to': a_end.isoformat(), 'currency': self.quote_currency},
        }
