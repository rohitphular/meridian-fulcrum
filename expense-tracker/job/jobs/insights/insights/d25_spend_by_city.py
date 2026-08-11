from jobs.insights.data_utils import (
    currency_symbol, filter_by_range, sum_amount_base, TEAL, AMBER,
)
from jobs.insights.base_insight import BaseInsight
from jobs.insights.insight_schema import TxField, TX_TYPE_MONEY_OUT

MAX_CITIES = 15
HOME_COUNTRY = 'United Kingdom'

_COUNTRY_MAP = {
    'uk': 'United Kingdom', 'gb': 'United Kingdom', 'england': 'United Kingdom',
    'us': 'United States',  'usa': 'United States', 'america': 'United States',
    'uae': 'UAE', 'in': 'India',
}


def _normalise_country(raw):
    s = (raw or '').strip()
    if not s:
        return ''
    lower = s.lower()
    return _COUNTRY_MAP.get(lower, s[0].upper() + s[1:])


def _city_key(tx):
    city    = (tx.get(TxField.LOCATION_CITY) or '').strip()
    country = _normalise_country(tx.get(TxField.LOCATION_COUNTRY))
    if city and country:
        return f'{city}, {country}', country, False
    if city:
        return city, '', False
    if country:
        return f'{country} (city unknown)', country, True
    return 'Unknown', '', True


def _fmt(v, sym):
    return f'{sym}{abs(v):,.0f}'


class D25SpendByCity(BaseInsight):
    insight_id     = '25-spend-by-city'
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

        groups  = {}  # label → {txs, country, is_unknown}
        for tx in money_out:
            label, country, is_unknown = _city_key(tx)
            if label not in groups:
                groups[label] = {'txs': [], 'country': country, 'is_unknown': is_unknown}
            groups[label]['txs'].append(tx)

        def _top_cat(txs_):
            cats = [tx.get(TxField.MAJOR_CATEGORY) or '' for tx in txs_]
            return max(set(cats), key=cats.count) if cats else '—'

        rows = []
        for label, g in groups.items():
            txs_    = g['txs']
            is_dom  = g['country'] == HOME_COUNTRY
            total   = round(sum_amount_base(txs_, self.rate_map, self.quote_currency), 2)
            rows.append({'label': label, 'total': total, 'count': len(txs_),
                         'avg': round(total / len(txs_), 2), 'top_cat': _top_cat(txs_),
                         'is_domestic': is_dom, 'is_unknown': g['is_unknown']})

        # Sort: domestic desc → international desc → unknown
        domestic    = sorted([r for r in rows if r['is_domestic'] and not r['is_unknown']],
                             key=lambda x: x['total'], reverse=True)
        foreign     = sorted([r for r in rows if not r['is_domestic'] and not r['is_unknown']],
                             key=lambda x: x['total'], reverse=True)
        unknown_    = [r for r in rows if r['is_unknown']]
        sorted_rows = domestic + foreign + unknown_

        if len(sorted_rows) > MAX_CITIES:
            top    = sorted_rows[:MAX_CITIES]
            others = sum(r['total'] for r in sorted_rows[MAX_CITIES:])
            others_count = sum(r['count'] for r in sorted_rows[MAX_CITIES:])
            top.append({'label': 'Other', 'total': round(others, 2), 'count': others_count,
                        'avg': 0, 'top_cat': '—', 'is_domestic': False, 'is_unknown': True})
            sorted_rows = top

        total_spend  = sum(r['total'] for r in rows)
        total_dom    = sum(r['total'] for r in rows if r['is_domestic'] and not r['is_unknown'])
        total_foreign= sum(r['total'] for r in rows if not r['is_domestic'] and not r['is_unknown'])
        known_count  = len([r for r in rows if not r['is_unknown']])
        dom_pct      = round(total_dom / total_spend * 100) if total_spend else 0
        for_pct      = round(total_foreign / total_spend * 100) if total_spend else 0

        colors = []
        for r in sorted_rows:
            if r['is_unknown']:
                colors.append('#94a3b8')
            elif r['is_domestic']:
                colors.append(TEAL)
            else:
                colors.append(AMBER)

        return {
            'stat_cards': [
                {'label': 'Total spend',    'value': _fmt(total_spend, sym),  'sub': '', 'class': ''},
                {'label': 'Cities',         'value': str(known_count),        'sub': '', 'class': ''},
                {'label': 'Domestic',       'value': _fmt(total_dom, sym),    'sub': f'({dom_pct}%)', 'class': ''},
                {'label': 'International',  'value': _fmt(total_foreign, sym),'sub': f'({for_pct}%)', 'class': ''},
            ],
            'chart': {
                'labels':   [r['label'] for r in sorted_rows],
                'data':     [r['total'] for r in sorted_rows],
                'colors':   colors,
                'indexAxis': 'y',
            },
            'meta': {
                'from':  from_date.isoformat() if from_date else None,
                'to':    to_date.isoformat()   if to_date   else None,
                'currency': self.quote_currency,
                'rows':  sorted_rows,
            },
        }
