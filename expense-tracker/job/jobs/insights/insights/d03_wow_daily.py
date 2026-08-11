from datetime import date, timedelta

from jobs.insights.base_insight import BaseInsight
from jobs.insights.data_utils import (
    currency_symbol, filter_by_range, sum_amount_base,
    compute_daily_total_assets, is_active_account,
    group_by_day, last_non_null, TEAL, AMBER,
)
from jobs.insights.insight_schema import TxField, AccountField, TX_TYPE_MONEY_OUT

WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']


def _fmt(v, sym):
    return f'{sym}{abs(v):,.0f}'


def _iso_week_label(monday):
    iso_year, iso_week, _ = monday.isocalendar()
    return f'W{iso_week:02d} {iso_year}'


class D03WowDaily(BaseInsight):
    insight_id     = '03-wow-daily'
    periods        = ['this_week', 'last_week', 'last_7']
    derived_from   = ['transactions', 'accounts']
    chart_variants = ['']

    def compute(self, raw, from_date, to_date, derived_from, variant):
        today    = date.today()
        sym      = currency_symbol(self.quote_currency)
        all_txs  = raw['transactions']
        accounts = raw['accounts']

        a_from = from_date
        a_to   = from_date + timedelta(days=6)
        b_from = from_date - timedelta(days=7)
        b_to   = from_date - timedelta(days=1)

        is_current_week = a_from <= today <= a_to

        if derived_from == 'transactions':
            return self._transactions(all_txs, a_from, a_to, b_from, b_to,
                                      is_current_week, today, sym)
        return self._accounts(accounts, all_txs, a_from, a_to, b_from, b_to,
                               is_current_week, today, sym)

    def _transactions(self, all_txs, a_from, a_to, b_from, b_to, is_current_week, today, sym):
        money_out_a = [tx for tx in filter_by_range(all_txs, a_from, a_to)
                       if tx.get(TxField.TYPE) == TX_TYPE_MONEY_OUT]
        money_out_b = [tx for tx in filter_by_range(all_txs, b_from, b_to)
                       if tx.get(TxField.TYPE) == TX_TYPE_MONEY_OUT]

        by_a = group_by_day(money_out_a)
        by_b = group_by_day(money_out_b)

        data_a, data_b = [], []
        for i in range(7):
            day_a = a_from + timedelta(days=i)
            day_b = b_from + timedelta(days=i)
            if is_current_week and day_a > today:
                data_a.append(None)
            else:
                data_a.append(round(sum_amount_base(by_a.get(day_a.isoformat(), []), self.rate_map, self.quote_currency), 2))
            data_b.append(round(sum_amount_base(by_b.get(day_b.isoformat(), []), self.rate_map, self.quote_currency), 2))

        total_a = sum_amount_base(money_out_a, self.rate_map, self.quote_currency)
        total_b = sum_amount_base(money_out_b, self.rate_map, self.quote_currency)
        delta   = total_a - total_b
        pct     = round(abs(delta) / abs(total_b) * 100) if total_b else None
        pcts    = f' ({pct}%)' if pct is not None else ''
        arrow   = '↓' if delta <= 0 else '↑'

        label_a = _iso_week_label(a_from) + (' (current)' if is_current_week else '')
        label_b = _iso_week_label(b_from) + ' (prev)'

        return {
            'stat_cards': [
                {'label': label_a,    'value': _fmt(total_a, sym), 'sub': '', 'class': ''},
                {'label': label_b,    'value': _fmt(total_b, sym), 'sub': '', 'class': ''},
                {'label': 'WoW change', 'value': f'{arrow} {_fmt(abs(delta), sym)}{pcts}', 'sub': '',
                 'class': 'positive' if delta <= 0 else 'negative'},
                {'label': 'Week', 'value': _iso_week_label(a_from), 'sub': '', 'class': ''},
            ],
            'chart': {
                'labels': WEEKDAYS,
                'datasets': [
                    {'label': label_a, 'data': data_a, 'borderColor': TEAL},
                    {'label': label_b, 'data': data_b, 'borderColor': AMBER},
                ],
            },
            'meta': {'from': a_from.isoformat(), 'to': a_to.isoformat(), 'currency': self.quote_currency},
        }

    def _accounts(self, accounts, all_txs, a_from, a_to, b_from, b_to, is_current_week, today, sym):
        asset_accts = [a for a in accounts if is_active_account(a) and a.get(AccountField.TYPE) != 'liability']
        if not asset_accts:
            return {'stat_cards': [], 'chart': None,
                    'meta': {'from': a_from.isoformat(), 'to': a_to.isoformat(), 'currency': self.quote_currency}}

        daily_a = compute_daily_total_assets(asset_accts, all_txs, a_from, a_to, self.rate_map, self.quote_currency)
        daily_b = compute_daily_total_assets(asset_accts, all_txs, b_from, b_to, self.rate_map, self.quote_currency)

        # For current week: null-out days after today (cutoff = days elapsed so far)
        cutoff = (today - a_from).days if is_current_week else None
        data_a = [None if (cutoff is not None and i >= cutoff) else v for i, v in enumerate(daily_a)]
        data_b = list(daily_b)[:7]

        latest_a = last_non_null(data_a)
        latest_b = last_non_null(data_b)
        delta    = latest_a - latest_b
        pct      = round(abs(delta) / abs(latest_b) * 100) if latest_b else None
        pcts     = f' ({pct}%)' if pct is not None else ''
        arrow    = '↑' if delta >= 0 else '↓'

        label_a = _iso_week_label(a_from) + (' (current)' if is_current_week else '')
        label_b = _iso_week_label(b_from) + ' (prev)'

        return {
            'stat_cards': [
                {'label': 'Current assets', 'value': _fmt(latest_a, sym), 'sub': '', 'class': ''},
                {'label': 'Prev week end',  'value': _fmt(latest_b, sym), 'sub': '', 'class': ''},
                {'label': 'WoW change', 'value': f'{arrow} {_fmt(abs(delta), sym)}{pcts}', 'sub': '',
                 'class': 'positive' if delta >= 0 else 'negative'},
                {'label': 'Week', 'value': _iso_week_label(a_from), 'sub': '', 'class': ''},
            ],
            'chart': {
                'labels': WEEKDAYS,
                'datasets': [
                    {'label': f'Assets {label_a}', 'data': data_a, 'borderColor': TEAL},
                    {'label': f'Assets {label_b}', 'data': data_b, 'borderColor': AMBER},
                ],
            },
            'meta': {'from': a_from.isoformat(), 'to': a_to.isoformat(), 'currency': self.quote_currency},
        }
