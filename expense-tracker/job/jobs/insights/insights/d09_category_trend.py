from jobs.insights.base_insight import BaseInsight
from jobs.insights.data_utils import (
    currency_symbol, filter_by_range, sum_amount_base, group_by_month,
    month_range, fmt_month_key, PALETTE,
)
from jobs.insights.insight_schema import TxField, TX_TYPE_MONEY_OUT


def _fmt(v, sym):
    return f'{sym}{abs(v):,.0f}'


class D09CategoryTrend(BaseInsight):
    insight_id     = '09-category-trend'
    periods        = ['last_6', 'last_12', 'ytd', 'last_year']
    derived_from   = ['default']
    chart_variants = ['']

    def compute(self, raw, from_date, to_date, derived_from, variant):
        sym     = currency_symbol(self.quote_currency)
        all_txs = raw['transactions']
        money_out = [tx for tx in filter_by_range(all_txs, from_date, to_date)
                     if tx.get(TxField.TYPE) == TX_TYPE_MONEY_OUT]

        month_keys = month_range(from_date, to_date)
        by_month   = group_by_month(money_out)

        # Build category × month matrix
        cat_totals = {}   # cat → {month_key → total}
        for mk in month_keys:
            txs = by_month.get(mk, [])
            cat_groups = {}
            for tx in txs:
                cat = tx.get(TxField.MAJOR_CATEGORY) or 'Uncategorised'
                cat_groups.setdefault(cat, []).append(tx)
            for cat, cat_txs in cat_groups.items():
                cat_totals.setdefault(cat, {})
                cat_totals[cat][mk] = sum_amount_base(cat_txs, self.rate_map, self.quote_currency)

        if not cat_totals:
            return {'stat_cards': [], 'chart': None,
                    'meta': {'from': from_date.isoformat() if from_date else None,
                             'to':   to_date.isoformat()   if to_date   else None,
                             'currency': self.quote_currency}}

        # Sort categories by grand total desc — largest to bottom of stack
        grand = {cat: sum(v for v in mk_map.values()) for cat, mk_map in cat_totals.items()}
        sorted_cats = sorted(grand, key=grand.get, reverse=True)

        datasets = []
        for i, cat in enumerate(sorted_cats):
            data = [round(cat_totals[cat].get(mk, 0.0), 2) for mk in month_keys]
            datasets.append({
                'label':           cat,
                'data':            data,
                'backgroundColor': PALETTE[i % len(PALETTE)] + 'cc',
                'stack':           'spend',
                'borderRadius':    2,
            })

        # Month totals for peak month
        month_totals = {mk: sum(cat_totals[c].get(mk, 0.0) for c in cat_totals) for mk in month_keys}
        peak_mk      = max(month_totals, key=month_totals.get, default=None)
        total_spend  = sum(grand.values())
        top_cat      = sorted_cats[0] if sorted_cats else '—'

        return {
            'stat_cards': [
                {'label': 'Total spend',   'value': _fmt(total_spend, sym),         'sub': '',          'class': ''},
                {'label': 'Top category',  'value': top_cat, 'sub': _fmt(grand.get(top_cat, 0), sym), 'class': ''},
                {'label': 'Peak month',    'value': fmt_month_key(peak_mk) if peak_mk else '—',
                 'sub': _fmt(month_totals.get(peak_mk, 0), sym), 'class': ''},
                {'label': 'Categories',   'value': str(len(sorted_cats)),           'sub': '',          'class': ''},
            ],
            'chart': {
                'labels':   [fmt_month_key(mk) for mk in month_keys],
                'datasets': datasets,
            },
            'meta': {
                'from':     from_date.isoformat() if from_date else None,
                'to':       to_date.isoformat()   if to_date   else None,
                'currency': self.quote_currency,
            },
        }
