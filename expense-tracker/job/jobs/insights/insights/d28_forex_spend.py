from jobs.insights.base_insight import BaseInsight
from jobs.insights.data_utils import (
    currency_symbol, filter_by_range, sum_amount_base, to_base, PALETTE,
)
from jobs.insights.insight_schema import TxField, TX_TYPE_MONEY_OUT

MAX_SEGMENTS = 8


def _fmt(v, sym):
    return f'{sym}{abs(v):,.0f}'


class D28ForexSpend(BaseInsight):
    insight_id     = '28-forex-spend'
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

        # Group by currency
        groups = {}
        for tx in money_out:
            ccy = (tx.get(TxField.CURRENCY) or self.quote_currency).strip().upper()
            groups.setdefault(ccy, []).append(tx)

        rows = []
        for ccy, txs_ in groups.items():
            native_total = sum(abs(float(tx.get(TxField.AMOUNT) or 0)) for tx in txs_)
            gbp_equiv    = round(sum_amount_base(txs_, self.rate_map, self.quote_currency), 2)
            fx_rates     = [float(tx.get(TxField.FX_RATE)) for tx in txs_ if tx.get(TxField.FX_RATE)]
            avg_rate     = round(sum(fx_rates) / len(fx_rates), 6) if fx_rates else self.rate_map.get(ccy)
            has_estimated= len(fx_rates) < len(txs_)
            is_domestic  = ccy == self.quote_currency

            # FX scatter points for foreign currencies
            scatter_pts = []
            if not is_domestic:
                from jobs.insights.data_utils import tx_date
                for tx in txs_:
                    d   = tx_date(tx)
                    fxr = tx.get(TxField.FX_RATE)
                    if d and fxr:
                        try:
                            scatter_pts.append({'date': d.isoformat(), 'rate': float(fxr)})
                        except (TypeError, ValueError):
                            pass

            rows.append({
                'currency':      ccy,
                'native_total':  round(native_total, 2),
                'gbp_equiv':     gbp_equiv,
                'count':         len(txs_),
                'avg':           round(gbp_equiv / len(txs_), 2),
                'avg_rate':      avg_rate,
                'has_estimated': has_estimated,
                'is_domestic':   is_domestic,
                'scatter':       scatter_pts,
            })

        rows.sort(key=lambda x: x['gbp_equiv'], reverse=True)
        total_spend = sum(r['gbp_equiv'] for r in rows)
        dom_spend   = sum(r['gbp_equiv'] for r in rows if r['is_domestic'])
        for_spend   = round(total_spend - dom_spend, 2)
        dom_pct     = round(dom_spend / total_spend * 100) if total_spend else 0
        for_pct     = 100 - dom_pct
        foreign_rows= [r for r in rows if not r['is_domestic']]
        largest_for = foreign_rows[0] if foreign_rows else None

        # Donut data
        if len(rows) > MAX_SEGMENTS:
            segs   = rows[:MAX_SEGMENTS]
            others = round(sum(r['gbp_equiv'] for r in rows[MAX_SEGMENTS:]), 2)
            segs.append({'currency': 'Other', 'gbp_equiv': others, 'count': 0,
                         'is_domestic': False, 'scatter': []})
        else:
            segs = rows

        colors = [PALETTE[i % len(PALETTE)] for i in range(len(segs))]

        return {
            'stat_cards': [
                {'label': 'Currencies used', 'value': str(len(rows)), 'sub': '', 'class': ''},
                {'label': f'Domestic ({self.quote_currency})',
                 'value': _fmt(dom_spend, sym), 'sub': f'({dom_pct}%)', 'class': ''},
                {'label': 'Foreign spend',
                 'value': _fmt(for_spend, sym), 'sub': f'({for_pct}%)', 'class': ''},
                {'label': 'Largest foreign',
                 'value': largest_for['currency'] if largest_for else '—',
                 'sub': _fmt(largest_for['gbp_equiv'], sym) if largest_for else '', 'class': ''},
            ],
            'chart': {
                'by_currency': {
                    'labels':  [r['currency'] for r in segs],
                    'amounts': [r['gbp_equiv'] for r in segs],
                    'colors':  colors,
                },
                'fx_rates': {
                    'datasets': [
                        {'label': r['currency'], 'data': r['scatter'], 'borderColor': PALETTE[i % len(PALETTE)]}
                        for i, r in enumerate(foreign_rows) if r['scatter']
                    ],
                },
            },
            'meta': {
                'from':     from_date.isoformat() if from_date else None,
                'to':       to_date.isoformat()   if to_date   else None,
                'currency': self.quote_currency,
                'rows':     rows,
            },
        }
