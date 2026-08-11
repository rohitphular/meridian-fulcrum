from datetime import date, timedelta

from jobs.insights.base_insight import BaseInsight
from jobs.insights.data_utils import (
    currency_symbol, filter_by_range, sum_amount_base, MONTH_ABBREV,
)
from jobs.insights.insight_schema import TxField, TX_TYPE_MONEY_IN, TX_TYPE_MONEY_OUT


def _fmt(v, sym):
    return f'{sym}{abs(v):,.0f}'


def _iso_week_label(monday, is_current):
    iso_year, iso_week, _ = monday.isocalendar()
    label = f'W{iso_week:02d}'
    return f'{label} (now)' if is_current else label


class D07Last8Weeks(BaseInsight):
    insight_id     = '07-last-8-weeks'
    periods        = ['default']
    derived_from   = ['default']
    chart_variants = ['']

    def compute(self, raw, from_date, to_date, derived_from, variant):
        today   = date.today()
        sym     = currency_symbol(self.quote_currency)
        all_txs = raw['transactions']

        # Monday of current week (Python weekday 0=Mon)
        current_monday = today - timedelta(days=today.weekday())
        weeks8 = [current_monday - timedelta(weeks=7 - i) for i in range(8)]

        income  = []
        expense = []

        for i, week_from in enumerate(weeks8):
            week_to     = week_from + timedelta(days=6)
            is_current  = i == 7
            clamped_to  = today if is_current else week_to
            txs = filter_by_range(all_txs, week_from, clamped_to)
            income.append(round(sum_amount_base([tx for tx in txs if tx.get(TxField.TYPE) == TX_TYPE_MONEY_IN],
                                                self.rate_map, self.quote_currency), 2))
            expense.append(round(sum_amount_base([tx for tx in txs if tx.get(TxField.TYPE) == TX_TYPE_MONEY_OUT],
                                                 self.rate_map, self.quote_currency), 2))

        total_income  = sum(income)
        total_expense = sum(expense)
        net           = total_income - total_expense
        avg_weekly    = total_expense / 8

        net_class = 'positive' if net >= 0 else 'negative'
        net_arrow = '↑' if net >= 0 else '↓'

        labels = [_iso_week_label(w, i == 7) for i, w in enumerate(weeks8)]

        return {
            'stat_cards': [
                {'label': 'Income (8 wks)',   'value': _fmt(total_income, sym),  'sub': '', 'class': 'positive'},
                {'label': 'Expenses (8 wks)', 'value': _fmt(total_expense, sym), 'sub': '', 'class': 'negative'},
                {'label': 'Net', 'value': f'{net_arrow} {_fmt(abs(net), sym)}', 'sub': '', 'class': net_class},
                {'label': 'Avg spend/wk', 'value': _fmt(avg_weekly, sym), 'sub': '', 'class': ''},
            ],
            'chart': {
                'labels': labels,
                'datasets': [
                    {'label': 'Income',   'data': income,  'backgroundColor': 'rgba(52,211,153,0.8)'},
                    {'label': 'Expenses', 'data': expense, 'backgroundColor': 'rgba(248,113,113,0.8)'},
                ],
            },
            'meta': {
                'from':     weeks8[0].isoformat(),
                'to':       today.isoformat(),
                'currency': self.quote_currency,
            },
        }
