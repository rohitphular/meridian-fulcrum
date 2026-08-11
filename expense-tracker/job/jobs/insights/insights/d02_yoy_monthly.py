import calendar
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


def _change_card(total_a, total_b, sym, label='YoY change', positive_when_down=True):
    delta = total_a - total_b
    pct   = round(abs(delta) / abs(total_b) * 100) if total_b else None
    pcts  = f' ({pct}%)' if pct is not None else ''
    arrow = '↓' if delta <= 0 else '↑'
    good  = (delta <= 0) == positive_when_down
    return {'label': label, 'value': f'{arrow} {_fmt(abs(delta), sym)}{pcts}', 'sub': '', 'class': 'positive' if good else 'negative'}


class D02YoyMonthly(BaseInsight):
    insight_id     = '02-yoy-monthly'
    periods        = ['this_month', 'last_month']
    derived_from   = ['transactions', 'accounts']
    chart_variants = ['']

    def compute(self, raw, from_date, to_date, derived_from, variant):
        today    = date.today()
        sym      = currency_symbol(self.quote_currency)
        all_txs  = raw['transactions']
        accounts = raw['accounts']

        # Period A = selected month (from_date, to_date)
        year_a, month_a = from_date.year, from_date.month
        _, days_in_a    = calendar.monthrange(year_a, month_a)
        a_from          = from_date                         # already 1st of month
        a_to            = to_date                           # already last day

        is_current_month = year_a == today.year and month_a == today.month
        cutoff_a         = today.day if is_current_month else None

        # Period B = same month, 1 year earlier
        year_b = year_a - 1
        _, days_in_b = calendar.monthrange(year_b, month_a)
        b_from = date(year_b, month_a, 1)
        b_to   = date(year_b, month_a, days_in_b)

        max_days = max(days_in_a, days_in_b)
        labels   = [str(d) for d in range(1, max_days + 1)]
        label_a  = a_from.strftime('%b %Y')
        label_b  = b_from.strftime('%b %Y')

        if derived_from == 'transactions':
            return self._transactions(all_txs, a_from, a_to, b_from, b_to,
                                      days_in_a, days_in_b, max_days, cutoff_a,
                                      is_current_month, labels, label_a, label_b, sym)
        return self._accounts(accounts, all_txs, a_from, a_to, b_from, b_to,
                               days_in_a, days_in_b, max_days, cutoff_a, labels, label_a, label_b, sym)

    def _transactions(self, all_txs, a_from, a_to, b_from, b_to,
                      days_in_a, days_in_b, max_days, cutoff_a,
                      is_current_month, labels, label_a, label_b, sym):
        money_out_a = [tx for tx in filter_by_range(all_txs, a_from, a_to)
                       if tx.get(TxField.TYPE) == TX_TYPE_MONEY_OUT]
        money_out_b = [tx for tx in filter_by_range(all_txs, b_from, b_to)
                       if tx.get(TxField.TYPE) == TX_TYPE_MONEY_OUT]

        data_a = build_cumulative(money_out_a, a_from, days_in_a, cutoff_a, self.rate_map, self.quote_currency)
        data_b = build_cumulative(money_out_b, b_from, days_in_b, None,     self.rate_map, self.quote_currency)
        while len(data_a) < max_days: data_a.append(None)
        while len(data_b) < max_days: data_b.append(None)

        total_a = sum_amount_base(money_out_a, self.rate_map, self.quote_currency)
        total_b = sum_amount_base(money_out_b, self.rate_map, self.quote_currency)
        month_name = a_from.strftime('%B')

        return {
            'stat_cards': [
                {'label': label_a,     'value': _fmt(total_a, sym), 'sub': '', 'class': ''},
                {'label': label_b,     'value': _fmt(total_b, sym), 'sub': '', 'class': ''},
                _change_card(total_a, total_b, sym, positive_when_down=True),
                {'label': 'Month', 'value': month_name, 'sub': '', 'class': ''},
            ],
            'chart': {
                'labels': labels,
                'datasets': [
                    {'label': label_a, 'data': data_a, 'borderColor': TEAL},
                    {'label': label_b, 'data': data_b, 'borderColor': AMBER},
                ],
            },
            'meta': {'from': a_from.isoformat(), 'to': a_to.isoformat(), 'currency': self.quote_currency},
        }

    def _accounts(self, accounts, all_txs, a_from, a_to, b_from, b_to,
                  days_in_a, days_in_b, max_days, cutoff_a, labels, label_a, label_b, sym):
        asset_accts = [a for a in accounts if is_active_account(a) and a.get(AccountField.TYPE) != 'liability']
        if not asset_accts:
            return {'stat_cards': [], 'chart': None,
                    'meta': {'from': a_from.isoformat(), 'to': a_to.isoformat(), 'currency': self.quote_currency}}

        daily_a = compute_daily_total_assets(asset_accts, all_txs, a_from, a_to, self.rate_map, self.quote_currency)
        daily_b = compute_daily_total_assets(asset_accts, all_txs, b_from, b_to, self.rate_map, self.quote_currency)

        data_a = [None if (cutoff_a and i + 1 > cutoff_a) else v for i, v in enumerate(daily_a)]
        data_b = list(daily_b)
        while len(data_a) < max_days: data_a.append(None)
        while len(data_b) < max_days: data_b.append(None)

        latest_a = last_non_null(data_a)
        latest_b = last_non_null(data_b)
        month_name = a_from.strftime('%B')

        return {
            'stat_cards': [
                {'label': f'Assets {label_a}', 'value': _fmt(latest_a, sym), 'sub': '', 'class': ''},
                {'label': f'Assets {label_b}', 'value': _fmt(latest_b, sym), 'sub': '', 'class': ''},
                _change_card(latest_a, latest_b, sym, 'YoY change', positive_when_down=False),
                {'label': 'Month', 'value': month_name, 'sub': '', 'class': ''},
            ],
            'chart': {
                'labels': labels,
                'datasets': [
                    {'label': f'Assets {label_a}', 'data': data_a, 'borderColor': TEAL},
                    {'label': f'Assets {label_b}', 'data': data_b, 'borderColor': AMBER},
                ],
            },
            'meta': {'from': a_from.isoformat(), 'to': a_to.isoformat(), 'currency': self.quote_currency},
        }
