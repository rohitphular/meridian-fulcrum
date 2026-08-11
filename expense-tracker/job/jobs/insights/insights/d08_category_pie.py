from jobs.insights.base_insight import BaseInsight
from jobs.insights.data_utils import (
    currency_symbol, filter_by_range, sum_amount_base, group_by_major,
    PALETTE,
)
from jobs.insights.insight_schema import TxField, TX_TYPE_MONEY_OUT

MAX_SEGMENTS = 8


def _fmt(v, sym):
    return f'{sym}{abs(v):,.0f}'


def _build_segments(money_out, rate_map, quote_currency):
    groups = group_by_major(money_out)
    segs   = sorted(
        [{'label': cat, 'amount': sum_amount_base(txs, rate_map, quote_currency)}
         for cat, txs in groups.items()],
        key=lambda x: x['amount'],
        reverse=True,
    )
    if len(segs) > MAX_SEGMENTS:
        top    = segs[:MAX_SEGMENTS - 1]
        others = sum(s['amount'] for s in segs[MAX_SEGMENTS - 1:])
        top.append({'label': 'Other', 'amount': others})
        segs = top
    return segs


def _build_minor_table(money_out, rate_map, quote_currency):
    groups = {}
    for tx in money_out:
        major = tx.get(TxField.MAJOR_CATEGORY) or 'Uncategorised'
        minor = tx.get(TxField.MINOR_CATEGORY) or '—'
        key   = f'{major}\t{minor}'
        groups.setdefault(key, []).append(tx)
    rows = sorted(
        [{'major': k.split('\t')[0], 'minor': k.split('\t')[1],
          'amount': sum_amount_base(txs, rate_map, quote_currency)}
         for k, txs in groups.items()],
        key=lambda x: x['amount'],
        reverse=True,
    )
    return rows[:10]


class D08CategoryPie(BaseInsight):
    insight_id     = '08-category-pie'
    periods        = ['last_3', 'last_6', 'last_12', 'ytd', 'last_year']
    derived_from   = ['default']
    chart_variants = ['']

    def compute(self, raw, from_date, to_date, derived_from, variant):
        sym     = currency_symbol(self.quote_currency)
        all_txs = raw['transactions']
        money_out = [tx for tx in filter_by_range(all_txs, from_date, to_date)
                     if tx.get(TxField.TYPE) == TX_TYPE_MONEY_OUT]

        segs = _build_segments(money_out, self.rate_map, self.quote_currency)
        if not segs:
            return {'stat_cards': [], 'chart': None,
                    'meta': {'from': from_date.isoformat() if from_date else None,
                             'to':   to_date.isoformat()   if to_date   else None,
                             'currency': self.quote_currency}}

        total   = sum(s['amount'] for s in segs)
        labels  = [s['label'] for s in segs]
        amounts = [round(s['amount'], 2) for s in segs]
        colors  = [PALETTE[i % len(PALETTE)] for i in range(len(segs))]
        minor   = _build_minor_table(money_out, self.rate_map, self.quote_currency)

        return {
            'stat_cards': [
                {'label': 'Total spend',  'value': _fmt(total, sym), 'sub': '', 'class': ''},
                {'label': 'Top category', 'value': segs[0]['label'],
                 'sub': _fmt(segs[0]['amount'], sym), 'class': ''},
                {'label': 'Categories',  'value': str(len(segs)), 'sub': '', 'class': ''},
            ],
            'chart': {
                'labels':   labels,
                'amounts':  amounts,
                'colors':   colors,
                'total':    round(total, 2),
            },
            'meta': {
                'from':             from_date.isoformat() if from_date else None,
                'to':               to_date.isoformat()   if to_date   else None,
                'currency':         self.quote_currency,
                'minor_categories': minor,
            },
        }
