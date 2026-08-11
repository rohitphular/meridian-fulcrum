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


def _change_card(total_a, total_b, sym, label='Change', positive_when_down=True):
    delta = total_a - total_b
    pct   = round(abs(delta) / abs(total_b) * 100) if total_b else None
    pcts  = f' ({pct}%)' if pct is not None else ''
    arrow = '↓' if delta <= 0 else '↑'
    good  = (delta <= 0) == positive_when_down
    return {'label': label, 'value': f'{arrow} {_fmt(abs(delta), sym)}{pcts}', 'sub': '', 'class': 'positive' if good else 'negative'}


class D01MomCumulative(BaseInsight):
    insight_id     = '01-mom-cumulative'
    periods        = ['this_month', 'last_month']
    derived_from   = ['transactions', 'accounts']
    chart_variants = ['']

    def compute(self, raw, from_date, to_date, derived_from, variant):
        today   = date.today()
        sym     = currency_symbol(self.quote_currency)
        all_txs = raw['transactions']
        accounts = raw['accounts']

        # Period A = [from_date, to_date]  (full calendar month)
        days_in_a       = to_date.day
        is_current_month = from_date.year == today.year and from_date.month == today.month
        cutoff_a        = today.day if is_current_month else None

        # Period B = month immediately before from_date
        b_to   = from_date - timedelta(days=1)
        b_from = b_to.replace(day=1)
        days_in_b = b_to.day

        max_days = max(days_in_a, days_in_b)
        labels   = [str(d) for d in range(1, max_days + 1)]

        label_a  = from_date.strftime('%B %Y')
        label_b  = b_from.strftime('%B %Y')

        if derived_from == 'transactions':
            return self._transactions(all_txs, from_date, to_date, b_from, b_to,
                                      days_in_a, days_in_b, max_days, cutoff_a,
                                      is_current_month, today, labels, label_a, label_b, sym)
        return self._accounts(accounts, all_txs, from_date, to_date, b_from, b_to,
                               days_in_a, days_in_b, max_days, cutoff_a, labels, label_a, label_b, sym)

    def _transactions(self, all_txs, from_date, to_date, b_from, b_to,
                      days_in_a, days_in_b, max_days, cutoff_a,
                      is_current_month, today, labels, label_a, label_b, sym):
        money_out_a = [tx for tx in filter_by_range(all_txs, from_date, to_date)
                       if tx.get(TxField.TYPE) == TX_TYPE_MONEY_OUT]
        money_out_b = [tx for tx in filter_by_range(all_txs, b_from, b_to)
                       if tx.get(TxField.TYPE) == TX_TYPE_MONEY_OUT]

        data_a = build_cumulative(money_out_a, from_date, days_in_a, cutoff_a, self.rate_map, self.quote_currency)
        data_b = build_cumulative(money_out_b, b_from,    days_in_b, None,     self.rate_map, self.quote_currency)
        while len(data_a) < max_days: data_a.append(None)
        while len(data_b) < max_days: data_b.append(None)

        total_a  = sum_amount_base(money_out_a, self.rate_map, self.quote_currency)
        total_b  = sum_amount_base(money_out_b, self.rate_map, self.quote_currency)
        today_card = {'label': 'Today',
                      'value': f'Day {today.day}' if is_current_month else '—',
                      'sub':   f'of {days_in_a} days' if is_current_month else '',
                      'class': ''}

        return {
            'stat_cards': [
                {'label': label_a, 'value': _fmt(total_a, sym), 'sub': '', 'class': ''},
                {'label': label_b, 'value': _fmt(total_b, sym), 'sub': '', 'class': ''},
                _change_card(total_a, total_b, sym, positive_when_down=True),
                today_card,
            ],
            'chart': {
                'labels': labels,
                'datasets': [
                    {'label': label_a, 'data': data_a, 'borderColor': TEAL},
                    {'label': label_b, 'data': data_b, 'borderColor': AMBER},
                ],
            },
            'meta': {'from': from_date.isoformat(), 'to': to_date.isoformat(), 'currency': self.quote_currency},
        }

    def _accounts(self, accounts, all_txs, from_date, to_date, b_from, b_to,
                  days_in_a, days_in_b, max_days, cutoff_a, labels, label_a, label_b, sym):
        asset_accts = [a for a in accounts if is_active_account(a) and a.get(AccountField.TYPE) != 'liability']
        if not asset_accts:
            return {'stat_cards': [], 'chart': None,
                    'meta': {'from': from_date.isoformat(), 'to': to_date.isoformat(), 'currency': self.quote_currency}}

        daily_a = compute_daily_total_assets(asset_accts, all_txs, from_date, to_date, self.rate_map, self.quote_currency)
        daily_b = compute_daily_total_assets(asset_accts, all_txs, b_from,    b_to,    self.rate_map, self.quote_currency)

        data_a = [None if (cutoff_a and i + 1 > cutoff_a) else v for i, v in enumerate(daily_a)]
        data_b = list(daily_b)
        while len(data_a) < max_days: data_a.append(None)
        while len(data_b) < max_days: data_b.append(None)

        latest_a    = last_non_null(data_a)
        last_month_end = last_non_null(data_b)

        return {
            'stat_cards': [
                {'label': 'Current assets',   'value': _fmt(latest_a, sym),       'sub': '', 'class': ''},
                {'label': 'Last month end',   'value': _fmt(last_month_end, sym),  'sub': '', 'class': ''},
                _change_card(latest_a, last_month_end, sym, positive_when_down=False),
                {'label': 'Asset accounts', 'value': str(len(asset_accts)), 'sub': '', 'class': ''},
            ],
            'chart': {
                'labels': labels,
                'datasets': [
                    {'label': f'Assets {label_a}', 'data': data_a, 'borderColor': TEAL},
                    {'label': f'Assets {label_b}', 'data': data_b, 'borderColor': AMBER},
                ],
            },
            'meta': {'from': from_date.isoformat(), 'to': to_date.isoformat(), 'currency': self.quote_currency},
        }
