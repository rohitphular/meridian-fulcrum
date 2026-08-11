from jobs.insights.base_insight import BaseInsight
from jobs.insights.data_utils import (
    currency_symbol, filter_by_range, sum_amount_base, group_by_month,
    month_range, fmt_month_key, split_tags, tx_amount_base, PALETTE,
)
from jobs.insights.insight_schema import TxField, TX_TYPE_MONEY_OUT


def _fmt(v, sym):
    return f'{sym}{abs(v):,.0f}'


class D13TagTrend(BaseInsight):
    insight_id     = '13-tag-trend'
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

        # Build {tag: {month_key: total}} with proportional attribution
        tag_month = {}
        for mk, txs in by_month.items():
            for tx in txs:
                tags = split_tags(tx)
                if not tags:
                    continue
                share = tx_amount_base(tx, self.rate_map, self.quote_currency) / len(tags)
                for tag in tags:
                    tag_month.setdefault(tag, {}).setdefault(mk, 0.0)
                    tag_month[tag][mk] += share

        if not tag_month:
            return {'stat_cards': [], 'chart': None,
                    'meta': {'from': from_date.isoformat() if from_date else None,
                             'to':   to_date.isoformat()   if to_date   else None,
                             'currency': self.quote_currency}}

        # Sort tags by grand total desc
        tag_totals = sorted(
            [(tag, sum(v for v in mk_map.values())) for tag, mk_map in tag_month.items()],
            key=lambda x: x[1],
            reverse=True,
        )

        datasets = []
        for i, (tag, grand_total) in enumerate(tag_totals):
            data = [round(tag_month[tag].get(mk, 0.0), 2) for mk in month_keys]
            datasets.append({
                'label':           tag,
                'data':            data,
                'hidden':          i >= 6,
                'borderColor':     PALETTE[i % len(PALETTE)],
                'backgroundColor': PALETTE[i % len(PALETTE)] + '22',
            })

        labels    = [fmt_month_key(mk) for mk in month_keys]
        top_tag   = tag_totals[0][0] if tag_totals else '—'
        top_total = tag_totals[0][1] if tag_totals else 0.0
        extra_sub = f'top 6 visible, {len(tag_totals) - 6} more hidden' if len(tag_totals) > 6 else ''

        return {
            'stat_cards': [
                {'label': 'Distinct tags', 'value': str(len(tag_totals)),
                 'sub':  extra_sub, 'class': ''},
                {'label': 'Top tag',       'value': top_tag,
                 'sub':  _fmt(top_total, sym), 'class': ''},
            ],
            'chart': {
                'labels':   labels,
                'datasets': datasets,
            },
            'meta': {
                'from':     from_date.isoformat() if from_date else None,
                'to':       to_date.isoformat()   if to_date   else None,
                'currency': self.quote_currency,
            },
        }
