from datetime import date

from jobs.insights.base_insight import BaseInsight
from jobs.insights.data_utils import (
    currency_symbol, filter_by_range, sum_amount_base, group_by_month,
    month_range, fmt_month_key, tx_date, MONTH_ABBREV,
)
from jobs.insights.insight_schema import TxField, TX_TYPE_MONEY_IN, TX_TYPE_MONEY_OUT


def _fmt(v, sym):
    return f'{sym}{abs(v):,.0f}'


def _rate_label(mk):
    y, m = map(int, mk.split('-'))
    return f"{MONTH_ABBREV[m - 1]} '{str(y)[2:]}"


class D20SavingsRate(BaseInsight):
    insight_id     = '20-savings-rate'
    periods        = ['last_6', 'last_12', 'ytd', 'last_year']
    derived_from   = ['default']
    chart_variants = ['']

    def compute(self, raw, from_date, to_date, derived_from, variant):
        today   = date.today()
        sym     = currency_symbol(self.quote_currency)
        all_txs = raw['transactions']

        month_keys = month_range(from_date, to_date)
        by_month   = group_by_month(filter_by_range(all_txs, from_date, to_date))

        cur_key  = f'{today.year}-{today.month:02d}'
        incomes  = []
        expenses = []
        rates    = []

        for mk in month_keys:
            txs = by_month.get(mk, [])
            if mk == cur_key:
                txs = [tx for tx in txs if tx_date(tx) is not None and tx_date(tx) <= today]
            inc = sum_amount_base([tx for tx in txs if tx.get(TxField.TYPE) == TX_TYPE_MONEY_IN],
                                  self.rate_map, self.quote_currency)
            exp = sum_amount_base([tx for tx in txs if tx.get(TxField.TYPE) == TX_TYPE_MONEY_OUT],
                                  self.rate_map, self.quote_currency)
            incomes.append(round(inc, 2))
            expenses.append(round(exp, 2))
            rates.append(round((inc - exp) / inc * 100, 1) if inc > 0 else None)

        non_null_rates = [(i, r) for i, r in enumerate(rates) if r is not None]
        avg_rate = round(sum(r for _, r in non_null_rates) / len(non_null_rates), 1) if non_null_rates else None

        best_idx  = max(non_null_rates, key=lambda x: x[1])[0] if non_null_rates else None
        worst_idx = min(non_null_rates, key=lambda x: x[1])[0] if non_null_rates else None

        # Trailing positive streak
        streak = 0
        for r in reversed(rates):
            if r is not None and r > 0:
                streak += 1
            else:
                break

        labels = [fmt_month_key(mk) for mk in month_keys]
        if month_keys and month_keys[-1] == cur_key:
            labels[-1] += '*'

        avg_class = 'positive' if (avg_rate or 0) >= 0 else 'negative'

        return {
            'stat_cards': [
                {'label': 'Avg savings rate',
                 'value': f'{avg_rate}%' if avg_rate is not None else 'N/A',
                 'sub': '', 'class': avg_class},
                {'label': 'Best month',
                 'value': f'{_rate_label(month_keys[best_idx])} ({rates[best_idx]}%)' if best_idx is not None else '—',
                 'sub': '', 'class': ''},
                {'label': 'Worst month',
                 'value': f'{_rate_label(month_keys[worst_idx])} ({rates[worst_idx]}%)' if worst_idx is not None else '—',
                 'sub': '', 'class': ''},
                {'label': 'Positive streak',
                 'value': f'{streak} months' if streak > 0 else '—',
                 'sub': '', 'class': ''},
            ],
            'chart': {
                'labels': labels,
                'datasets': [
                    {'label': 'Income',        'data': incomes,  'backgroundColor': 'rgba(52,211,153,0.5)',  'type': 'bar',  'yAxisID': 'y'},
                    {'label': 'Expenses',      'data': expenses, 'backgroundColor': 'rgba(248,113,113,0.5)', 'type': 'bar',  'yAxisID': 'y'},
                    {'label': 'Savings %',     'data': rates,    'borderColor': '#f59e0b',                   'type': 'line', 'yAxisID': 'y2',
                     'borderWidth': 2.5, 'pointRadius': 5, 'spanGaps': False},
                ],
            },
            'meta': {
                'from':     from_date.isoformat() if from_date else None,
                'to':       to_date.isoformat()   if to_date   else None,
                'currency': self.quote_currency,
                'is_partial': month_keys[-1] == cur_key if month_keys else False,
            },
        }
