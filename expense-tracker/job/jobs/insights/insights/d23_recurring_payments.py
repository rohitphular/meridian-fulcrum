import math
from datetime import date

from jobs.insights.base_insight import BaseInsight
from jobs.insights.data_utils import (
    currency_symbol, filter_by_range, sum_amount_base, tx_date,
    group_by_month, month_range, PALETTE,
)
from jobs.insights.insight_schema import TxField, TX_TYPE_MONEY_IN, TX_TYPE_MONEY_OUT

MONTHLY_EQUIV = {'weekly': 52 / 12, 'monthly': 1, 'quarterly': 1 / 3}


def _mean(arr):
    return sum(arr) / len(arr) if arr else 0.0


def _std_dev(arr):
    if len(arr) < 2:
        return 0.0
    m = _mean(arr)
    return math.sqrt(sum((x - m) ** 2 for x in arr) / len(arr))


def _detect_frequency(gaps):
    if not gaps:
        return None
    m  = _mean(gaps)
    sd = _std_dev(gaps)
    if 5 <= m <= 9  and sd <= 2: return 'weekly'
    if 28 <= m <= 35 and sd <= 5: return 'monthly'
    if 85 <= m <= 95 and sd <= 7: return 'quarterly'
    return None


def _detect_recurring(money_out, rate_map, quote_currency):
    groups = {}
    for tx in money_out:
        key     = (tx.get(TxField.COUNTERPARTY) or '').strip().lower() or 'unknown'
        display = (tx.get(TxField.COUNTERPARTY) or '').strip() or 'Unknown'
        groups.setdefault(key, {'display': display, 'txs': []})['txs'].append(tx)

    detected = []
    for key, g in groups.items():
        txs = g['txs']
        if len(txs) < 2:
            continue

        amounts = [float(tx.get(TxField.AMOUNT) or 0) for tx in txs]
        if not all(amounts):
            continue
        mean_amt = _mean(amounts)
        if mean_amt == 0 or _std_dev(amounts) / mean_amt > 0.05:
            continue

        dates = sorted(d for tx in txs if (d := tx_date(tx)) is not None)
        if len(dates) < 2:
            continue
        gaps = [(dates[i + 1] - dates[i]).days for i in range(len(dates) - 1)]
        freq = _detect_frequency(gaps)
        if not freq:
            continue

        amt_base = round(sum_amount_base(txs, rate_map, quote_currency) / len(txs), 2)
        cat      = max(set(tx.get(TxField.MAJOR_CATEGORY, '') or '' for tx in txs), key=list(
            tx.get(TxField.MAJOR_CATEGORY, '') or '' for tx in txs).count)
        detected.append({
            'counterparty': g['display'],
            'amount_base':  amt_base,
            'frequency':    freq,
            'count':        len(txs),
            'last_date':    dates[-1].isoformat(),
            'category':     cat,
        })

    detected.sort(key=lambda x: x['amount_base'], reverse=True)
    return detected


def _fmt(v, sym):
    return f'{sym}{abs(v):,.0f}'


class D23RecurringPayments(BaseInsight):
    insight_id     = '23-recurring-payments'
    periods        = ['last_6', 'last_12', 'ytd']
    derived_from   = ['default']
    chart_variants = ['']

    def compute(self, raw, from_date, to_date, derived_from, variant):
        today   = date.today()
        sym     = currency_symbol(self.quote_currency)
        all_txs = raw['transactions']

        period_txs = filter_by_range(all_txs, from_date, to_date)
        money_out  = [tx for tx in period_txs if tx.get(TxField.TYPE) == TX_TYPE_MONEY_OUT]
        money_in   = [tx for tx in period_txs if tx.get(TxField.TYPE) == TX_TYPE_MONEY_IN]

        recurring = _detect_recurring(money_out, self.rate_map, self.quote_currency)

        total_monthly = round(sum(r['amount_base'] * MONTHLY_EQUIV[r['frequency']] for r in recurring), 2)

        # Monthly income (avg)
        month_keys = month_range(from_date, to_date)
        by_month   = group_by_month(money_in)
        monthly_inc = [sum_amount_base(by_month.get(mk, []), self.rate_map, self.quote_currency) for mk in month_keys]
        avg_monthly_inc = _mean([v for v in monthly_inc if v > 0])
        pct_of_inc = round(total_monthly / avg_monthly_inc * 100, 1) if avg_monthly_inc > 0 else None

        return {
            'stat_cards': [
                {'label': 'Recurring / month', 'value': _fmt(total_monthly, sym), 'sub': '', 'class': ''},
                {'label': '% of income',
                 'value': f'{pct_of_inc}%' if pct_of_inc is not None else '—',
                 'sub': '', 'class': 'negative' if (pct_of_inc or 0) > 50 else ''},
                {'label': 'Count',         'value': str(len(recurring)), 'sub': '', 'class': ''},
                {'label': 'Largest',
                 'value': recurring[0]['counterparty'][:12] if recurring else '—',
                 'sub': _fmt(recurring[0]['amount_base'], sym) if recurring else '',
                 'class': ''},
            ],
            'chart': {
                'labels': [r['counterparty'] for r in recurring],
                'data':   [r['amount_base'] for r in recurring],
                'colors': [PALETTE[i % len(PALETTE)] for i in range(len(recurring))],
                'indexAxis': 'y',
            },
            'meta': {
                'from':      from_date.isoformat() if from_date else None,
                'to':        to_date.isoformat()   if to_date   else None,
                'currency':  self.quote_currency,
                'recurring': recurring,
            },
        }
