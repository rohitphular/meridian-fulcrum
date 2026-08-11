from jobs.insights.base_insight import BaseInsight
from jobs.insights.data_utils import (
    currency_symbol, filter_by_range, aggregate_tags, PALETTE,
)
from jobs.insights.insight_schema import TxField, TX_TYPE_MONEY_OUT

MAX_SEGMENTS = 8


def _fmt(v, sym):
    return f'{sym}{abs(v):,.0f}'


class D12TagPie(BaseInsight):
    insight_id     = '12-tag-pie'
    periods        = ['last_3', 'last_6', 'last_12', 'ytd', 'last_year']
    derived_from   = ['default']
    chart_variants = ['']

    def compute(self, raw, from_date, to_date, derived_from, variant):
        sym     = currency_symbol(self.quote_currency)
        all_txs = raw['transactions']
        money_out = [tx for tx in filter_by_range(all_txs, from_date, to_date)
                     if tx.get(TxField.TYPE) == TX_TYPE_MONEY_OUT]

        all_rows = aggregate_tags(money_out, self.rate_map, self.quote_currency)
        if not all_rows:
            return {'stat_cards': [], 'chart': None,
                    'meta': {'from': from_date.isoformat() if from_date else None,
                             'to':   to_date.isoformat()   if to_date   else None,
                             'currency': self.quote_currency}}

        # Cap segments
        if len(all_rows) > MAX_SEGMENTS:
            segs   = all_rows[:MAX_SEGMENTS - 1]
            others = sum(r['amount'] for r in all_rows[MAX_SEGMENTS - 1:])
            segs.append({'label': 'Other tags', 'amount': round(others, 2), 'count': 0})
        else:
            segs = all_rows

        labels  = [s['label'] for s in segs]
        amounts = [s['amount'] for s in segs]
        colors  = [PALETTE[i % len(PALETTE)] for i in range(len(segs))]

        tagged_count = sum(r['count'] for r in all_rows)

        return {
            'stat_cards': [
                {'label': 'Distinct tags', 'value': str(len(all_rows)), 'sub': '', 'class': ''},
                {'label': 'Tagged txs',
                 'value': str(tagged_count),
                 'sub':   f'of {len(money_out)} expenses',
                 'class': ''},
            ],
            'chart': {
                'labels':   labels,
                'amounts':  amounts,
                'colors':   colors,
                'tag_count': len(all_rows),
            },
            'meta': {
                'from':     from_date.isoformat() if from_date else None,
                'to':       to_date.isoformat()   if to_date   else None,
                'currency': self.quote_currency,
                'all_tags': [{'label': r['label'], 'amount': r['amount'], 'count': r['count']}
                             for r in all_rows],
            },
        }
