from jobs.insights.data_utils import (
    currency_symbol, filter_by_range, sum_amount_base, TEAL,
)
from jobs.insights.base_insight import BaseInsight
from jobs.insights.insight_schema import TxField, TX_TYPE_MONEY_OUT

MAX_COUNTRIES = 15

_COUNTRY_MAP = {
    'uk': 'United Kingdom', 'gb': 'United Kingdom', 'england': 'United Kingdom',
    'us': 'United States',  'usa': 'United States', 'america': 'United States',
    'uae': 'UAE', 'in': 'India',
}


def _normalise_country(raw):
    s = (raw or '').strip()
    if not s:
        return 'Unknown'
    lower = s.lower()
    return _COUNTRY_MAP.get(lower, s[0].upper() + s[1:])


def _fmt(v, sym):
    return f'{sym}{abs(v):,.0f}'


class D24SpendByCountry(BaseInsight):
    insight_id     = '24-spend-by-country'
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

        groups = {}
        for tx in money_out:
            country = _normalise_country(tx.get(TxField.LOCATION_COUNTRY))
            groups.setdefault(country, []).append(tx)

        def _top_cat(txs_):
            cats = [tx.get(TxField.MAJOR_CATEGORY) or '' for tx in txs_]
            return max(set(cats), key=cats.count) if cats else '—'

        rows = []
        for country, txs_ in groups.items():
            total = round(sum_amount_base(txs_, self.rate_map, self.quote_currency), 2)
            rows.append({'country': country, 'total': total, 'count': len(txs_),
                         'avg': round(total / len(txs_), 2), 'top_cat': _top_cat(txs_)})

        # Sort: known non-unknown countries by total desc, Unknown always last
        known = sorted([r for r in rows if r['country'] != 'Unknown'],
                       key=lambda x: x['total'], reverse=True)
        unknown = [r for r in rows if r['country'] == 'Unknown']
        sorted_rows = known + unknown

        # Cap at MAX_COUNTRIES
        if len(sorted_rows) > MAX_COUNTRIES:
            top     = sorted_rows[:MAX_COUNTRIES]
            others  = sum(r['total'] for r in sorted_rows[MAX_COUNTRIES:])
            others_count = sum(r['count'] for r in sorted_rows[MAX_COUNTRIES:])
            top.append({'country': 'Other', 'total': round(others, 2), 'count': others_count,
                        'avg': 0, 'top_cat': '—'})
            sorted_rows = top

        total_spend   = sum(r['total'] for r in rows)
        known_count   = len([r for r in rows if r['country'] not in ('Unknown', 'Other')])
        top_known     = known[0] if known else None
        top_pct       = round(top_known['total'] / total_spend * 100) if top_known and total_spend else 0

        labels  = [r['country'] for r in sorted_rows]
        amounts = [r['total']   for r in sorted_rows]
        colors  = [('#94a3b8' if r['country'] in ('Unknown', 'Other') else TEAL) for r in sorted_rows]

        return {
            'stat_cards': [
                {'label': 'Total spend',     'value': _fmt(total_spend, sym), 'sub': '', 'class': ''},
                {'label': 'Countries',        'value': str(known_count),      'sub': '', 'class': ''},
                {'label': 'Top country',      'value': top_known['country'] if top_known else '—',
                 'sub': _fmt(top_known['total'], sym) if top_known else '', 'class': ''},
                {'label': 'Top country %',    'value': f'{top_pct}%',         'sub': '', 'class': ''},
            ],
            'chart': {
                'labels':   labels,
                'data':     amounts,
                'colors':   colors,
                'indexAxis': 'y',
            },
            'meta': {
                'from':     from_date.isoformat() if from_date else None,
                'to':       to_date.isoformat()   if to_date   else None,
                'currency': self.quote_currency,
                'rows':     sorted_rows,
            },
        }
