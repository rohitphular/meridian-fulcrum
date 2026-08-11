import calendar
from datetime import date, timedelta

from jobs.insights.base_insight import BaseInsight
from jobs.insights.data_utils import (
    currency_symbol, filter_by_range, sum_amount_base,
    compute_daily_total_assets, is_active_account, group_by_major, TEAL,
)
from jobs.insights.insight_schema import TxField, AccountField, TX_TYPE_MONEY_IN, TX_TYPE_MONEY_OUT

MAX_CATS = 10


def _fmt(v, sym):
    prefix = '−' if v < 0 else ''
    return f'{prefix}{sym}{abs(v):,.0f}'


class D19CashflowWaterfall(BaseInsight):
    insight_id     = '19-cashflow-waterfall'
    periods        = ['this_month', 'last_month']
    derived_from   = ['default']
    chart_variants = ['']

    def compute(self, raw, from_date, to_date, derived_from, variant):
        sym      = currency_symbol(self.quote_currency)
        all_txs  = raw['transactions']
        accounts = raw['accounts']

        active = [a for a in accounts if is_active_account(a)]

        # Opening balance = net worth at end of previous month
        prev_end = from_date - timedelta(days=1)
        if active:
            daily_prev = compute_daily_total_assets(active, all_txs, prev_end, prev_end,
                                                    self.rate_map, self.quote_currency)
            opening = round(daily_prev[0] if daily_prev else 0.0, 2)
        else:
            opening = 0.0

        period_txs = filter_by_range(all_txs, from_date, to_date)
        money_in   = [tx for tx in period_txs if tx.get(TxField.TYPE) == TX_TYPE_MONEY_IN]
        money_out  = [tx for tx in period_txs if tx.get(TxField.TYPE) == TX_TYPE_MONEY_OUT]

        income   = round(sum_amount_base(money_in,  self.rate_map, self.quote_currency), 2)
        expenses = round(sum_amount_base(money_out, self.rate_map, self.quote_currency), 2)
        closing  = round(opening + income - expenses, 2)

        # Expense breakdown by major category (max 10)
        cat_groups = group_by_major(money_out)
        cats = sorted(
            [{'label': cat, 'amount': round(sum_amount_base(txs_, self.rate_map, self.quote_currency), 2)}
             for cat, txs_ in cat_groups.items()],
            key=lambda x: x['amount'],
            reverse=True,
        )
        if len(cats) > MAX_CATS:
            top    = cats[:MAX_CATS]
            others = round(sum(c['amount'] for c in cats[MAX_CATS:]), 2)
            top.append({'label': 'Other expenses', 'amount': others})
            cats = top

        # Build waterfall bars: base + visible values
        labels    = ['Opening', 'Income'] + [c['label'] for c in cats] + ['Closing']
        base_vals = []
        vis_vals  = []
        colors    = []
        rt = opening

        # Opening bar
        base_vals.append(0)
        vis_vals.append(opening)
        colors.append(TEAL)
        # Income bar
        base_vals.append(rt)
        vis_vals.append(income)
        colors.append('rgba(52,211,153,0.85)')
        rt += income
        # Expense bars (drop)
        for c in cats:
            base_vals.append(rt - c['amount'])
            vis_vals.append(c['amount'])
            colors.append('#f87171')
            rt -= c['amount']
        # Closing bar
        base_vals.append(0)
        vis_vals.append(closing)
        colors.append(TEAL if closing >= 0 else '#f87171')

        return {
            'stat_cards': [
                {'label': 'Opening balance', 'value': _fmt(opening, sym),  'sub': '', 'class': ''},
                {'label': 'Total income',    'value': _fmt(income, sym),   'sub': '', 'class': 'positive'},
                {'label': 'Total expenses',  'value': _fmt(expenses, sym), 'sub': '', 'class': 'negative'},
                {'label': 'Closing balance', 'value': _fmt(closing, sym),  'sub': '',
                 'class': 'positive' if closing >= 0 else 'negative'},
            ],
            'chart': {
                'labels':   labels,
                'datasets': [
                    {'label': '',       'data': base_vals, 'backgroundColor': 'rgba(0,0,0,0)',
                     'stack': 'wf', 'borderWidth': 0},
                    {'label': 'Amount', 'data': vis_vals,  'backgroundColor': colors,
                     'stack': 'wf', 'borderRadius': 4},
                ],
            },
            'meta': {
                'from':    from_date.isoformat(),
                'to':      to_date.isoformat(),
                'currency': self.quote_currency,
            },
        }
