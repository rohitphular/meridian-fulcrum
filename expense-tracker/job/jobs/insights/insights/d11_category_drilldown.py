from jobs.insights.base_insight import BaseInsight
from jobs.insights.data_utils import (
    currency_symbol, filter_by_range, sum_amount_base, group_by_major,
    PALETTE,
)
from jobs.insights.insight_schema import TxField, TX_TYPE_MONEY_OUT


def _fmt(v, sym):
    return f'{sym}{abs(v):,.0f}'


class D11CategoryDrilldown(BaseInsight):
    insight_id     = '11-category-drilldown'
    periods        = ['last_3', 'last_6', 'last_12', 'ytd', 'last_year']
    derived_from   = ['default']
    chart_variants = ['']

    def compute(self, raw, from_date, to_date, derived_from, variant):
        sym     = currency_symbol(self.quote_currency)
        all_txs = raw['transactions']
        money_out = [tx for tx in filter_by_range(all_txs, from_date, to_date)
                     if tx.get(TxField.TYPE) == TX_TYPE_MONEY_OUT]

        major_groups = group_by_major(money_out)
        majors = sorted(
            [{'cat': cat, 'amount': sum_amount_base(txs_, self.rate_map, self.quote_currency)}
             for cat, txs_ in major_groups.items()],
            key=lambda x: x['amount'],
            reverse=True,
        )

        if not majors:
            return {'stat_cards': [], 'chart': None,
                    'meta': {'from': from_date.isoformat() if from_date else None,
                             'to':   to_date.isoformat()   if to_date   else None,
                             'currency': self.quote_currency}}

        total = sum(m['amount'] for m in majors)

        # Build drilldown map: {major → sorted list of minor categories with amounts}
        drilldown = {}
        for i, major_item in enumerate(majors):
            cat  = major_item['cat']
            txs_ = major_groups[cat]
            minor_groups = {}
            for tx in txs_:
                minor = tx.get(TxField.MINOR_CATEGORY) or 'Other'
                minor_groups.setdefault(minor, []).append(tx)
            minors = sorted(
                [{'cat': m, 'amount': round(sum_amount_base(mtxs, self.rate_map, self.quote_currency), 2)}
                 for m, mtxs in minor_groups.items()],
                key=lambda x: x['amount'],
                reverse=True,
            )
            drilldown[cat] = minors

        labels  = [m['cat'] for m in majors]
        amounts = [round(m['amount'], 2) for m in majors]
        colors  = [PALETTE[i % len(PALETTE)] for i in range(len(majors))]

        return {
            'stat_cards': [
                {'label': 'Total spend',  'value': _fmt(total, sym),       'sub': 'tap bar to drill in', 'class': ''},
                {'label': 'Categories',   'value': str(len(majors)),       'sub': '',                    'class': ''},
            ],
            'chart': {
                'labels':   labels,
                'amounts':  amounts,
                'colors':   colors,
                'indexAxis': 'y',
            },
            'meta': {
                'from':      from_date.isoformat() if from_date else None,
                'to':        to_date.isoformat()   if to_date   else None,
                'currency':  self.quote_currency,
                'drilldown': drilldown,
            },
        }
