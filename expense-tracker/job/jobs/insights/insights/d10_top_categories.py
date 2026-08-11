from datetime import date, timedelta

from jobs.insights.base_insight import BaseInsight
from jobs.insights.data_utils import (
    currency_symbol, filter_by_range, sum_amount_base, TEAL, AMBER,
)
from jobs.insights.insight_schema import TxField, TX_TYPE_MONEY_OUT

TOP_N = 10


def _fmt(v, sym):
    return f'{sym}{abs(v):,.0f}'


def _group_by_minor(txs, rate_map, quote_currency):
    groups = {}
    for tx in txs:
        key = tx.get(TxField.MINOR_CATEGORY) or 'Uncategorised'
        groups.setdefault(key, []).append(tx)
    return {k: sum_amount_base(txs_, rate_map, quote_currency) for k, txs_ in groups.items()}


class D10TopCategories(BaseInsight):
    insight_id     = '10-top-categories'
    periods        = ['this_month', 'last_month']
    derived_from   = ['default']
    chart_variants = ['']

    def compute(self, raw, from_date, to_date, derived_from, variant):
        sym     = currency_symbol(self.quote_currency)
        all_txs = raw['transactions']

        # Period A = selected month
        money_out_a = [tx for tx in filter_by_range(all_txs, from_date, to_date)
                       if tx.get(TxField.TYPE) == TX_TYPE_MONEY_OUT]

        # Period B = month immediately before from_date
        b_to   = from_date - timedelta(days=1)
        b_from = b_to.replace(day=1)
        money_out_b = [tx for tx in filter_by_range(all_txs, b_from, b_to)
                       if tx.get(TxField.TYPE) == TX_TYPE_MONEY_OUT]

        map_a = _group_by_minor(money_out_a, self.rate_map, self.quote_currency)
        map_b = _group_by_minor(money_out_b, self.rate_map, self.quote_currency)

        if not map_a:
            return {'stat_cards': [], 'chart': None,
                    'meta': {'from': from_date.isoformat(), 'to': to_date.isoformat(),
                             'currency': self.quote_currency}}

        # Sort by Period A desc, take top N
        top = sorted(map_a.items(), key=lambda x: x[1], reverse=True)[:TOP_N]
        categories = [r[0] for r in top]
        amts_a     = [round(r[1], 2) for r in top]
        amts_b     = [round(map_b.get(cat, 0.0), 2) for cat in categories]

        label_a = from_date.strftime('%b %Y')
        label_b = b_from.strftime('%b %Y')

        # Delta list for meta
        deltas = [{'category': cat, 'delta': round(amts_a[i] - amts_b[i], 2),
                   'period_b_label': label_b}
                  for i, cat in enumerate(categories)]

        return {
            'stat_cards': [
                {'label': f'Total ({label_a})', 'value': _fmt(sum(amts_a), sym), 'sub': '', 'class': ''},
                {'label': f'Total ({label_b})', 'value': _fmt(sum(amts_b), sym), 'sub': '', 'class': ''},
            ],
            'chart': {
                'labels':   categories,
                'datasets': [
                    {'label': label_a, 'data': amts_a, 'backgroundColor': TEAL,      'borderRadius': 4},
                    {'label': label_b, 'data': amts_b, 'backgroundColor': AMBER + '99', 'borderRadius': 4},
                ],
                'indexAxis': 'y',
            },
            'meta': {
                'from':     from_date.isoformat(),
                'to':       to_date.isoformat(),
                'currency': self.quote_currency,
                'deltas':   deltas,
            },
        }
