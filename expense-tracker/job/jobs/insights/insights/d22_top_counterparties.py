from jobs.insights.base_insight import BaseInsight
from jobs.insights.data_utils import (
    currency_symbol, filter_by_range, sum_amount_base, TEAL,
)
from jobs.insights.insight_schema import TxField, TX_TYPE_MONEY_OUT

MAX_ROWS = 20


def _fmt(v, sym):
    return f'{sym}{abs(v):,.0f}'


def _normalise_counterparty(raw):
    s = (raw or '').strip()
    return s.lower() if s else 'unknown merchant'


class D22TopCounterparties(BaseInsight):
    insight_id     = '22-top-counterparties'
    periods        = ['last_3', 'last_6', 'last_12', 'ytd', 'last_year']
    derived_from   = ['default']
    chart_variants = ['']

    def compute(self, raw, from_date, to_date, derived_from, variant):
        sym     = currency_symbol(self.quote_currency)
        all_txs = raw['transactions']
        money_out = [tx for tx in filter_by_range(all_txs, from_date, to_date)
                     if tx.get(TxField.TYPE) == TX_TYPE_MONEY_OUT]

        if not money_out:
            return {'stat_cards': [], 'chart': None,
                    'meta': {'from': from_date.isoformat() if from_date else None,
                             'to':   to_date.isoformat()   if to_date   else None,
                             'currency': self.quote_currency}}

        # Group by normalised counterparty
        groups = {}   # lower_key → {display_label, txs}
        for tx in money_out:
            raw_cp  = tx.get(TxField.COUNTERPARTY) or ''
            key     = _normalise_counterparty(raw_cp)
            display = raw_cp.strip() or 'Unknown merchant'
            if key not in groups:
                groups[key] = {'label': display, 'txs': []}
            groups[key]['txs'].append(tx)

        rows = sorted(
            [{'label': g['label'],
              'total': round(sum_amount_base(g['txs'], self.rate_map, self.quote_currency), 2),
              'count': len(g['txs'])}
             for g in groups.values()],
            key=lambda x: x['total'],
            reverse=True,
        )

        total_spend = sum(r['total'] for r in rows)
        top_n       = rows[:MAX_ROWS]

        return {
            'stat_cards': [
                {'label': 'Total spend',    'value': _fmt(total_spend, sym),      'sub': '', 'class': ''},
                {'label': 'Merchants',      'value': str(len(rows)),              'sub': '', 'class': ''},
                {'label': 'Transactions',   'value': str(len(money_out)),         'sub': '', 'class': ''},
                {'label': 'Top merchant',   'value': rows[0]['label'][:18] if rows else '—',
                 'sub': _fmt(rows[0]['total'], sym) if rows else '', 'class': ''},
            ],
            'chart': {
                'labels':   [r['label'] for r in top_n],
                'data':     [r['total'] for r in top_n],
                'colors':   [TEAL] * len(top_n),
                'counts':   [r['count'] for r in top_n],
                'indexAxis': 'y',
            },
            'meta': {
                'from':     from_date.isoformat() if from_date else None,
                'to':       to_date.isoformat()   if to_date   else None,
                'currency': self.quote_currency,
                'all_rows': rows,
            },
        }
