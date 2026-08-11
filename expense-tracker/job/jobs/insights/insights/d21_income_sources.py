from jobs.insights.base_insight import BaseInsight
from jobs.insights.data_utils import (
    currency_symbol, filter_by_range, sum_amount_base, group_by_month,
    month_range, fmt_month_key, PALETTE,
)
from jobs.insights.insight_schema import TxField, TX_TYPE_MONEY_IN

MAX_SEGMENTS = 8


def _fmt(v, sym):
    return f'{sym}{abs(v):,.0f}'


def _group_income(in_txs, field, fallback, rate_map, quote_currency, sym):
    groups = {}
    for tx in in_txs:
        key = tx.get(field) or fallback
        groups.setdefault(key, []).append(tx)
    segs = sorted(
        [{'label': k, 'amount': round(sum_amount_base(txs_, rate_map, quote_currency), 2)}
         for k, txs_ in groups.items()],
        key=lambda x: x['amount'],
        reverse=True,
    )
    total = sum(s['amount'] for s in segs)
    if len(segs) > MAX_SEGMENTS:
        top    = segs[:MAX_SEGMENTS]
        others = round(sum(s['amount'] for s in segs[MAX_SEGMENTS:]), 2)
        top.append({'label': 'Other', 'amount': others})
        segs = top
    colors = [PALETTE[i % len(PALETTE)] for i in range(len(segs))]

    # Concentrated income warning (one source > 90%)
    warning = None
    if segs and total > 0:
        top_share = segs[0]['amount'] / total
        if top_share > 0.9:
            warning = f"Concentrated income — {segs[0]['label']} accounts for {round(top_share * 100)}%"

    return {
        'labels':  [s['label'] for s in segs],
        'amounts': [s['amount'] for s in segs],
        'colors':  colors,
        'total':   round(total, 2),
        'warning': warning,
    }


class D21IncomeSources(BaseInsight):
    insight_id     = '21-income-sources'
    periods        = ['last_3', 'last_6', 'last_12', 'ytd', 'last_year']
    derived_from   = ['default']
    chart_variants = ['']

    def compute(self, raw, from_date, to_date, derived_from, variant):
        sym     = currency_symbol(self.quote_currency)
        all_txs = raw['transactions']
        in_txs  = [tx for tx in filter_by_range(all_txs, from_date, to_date)
                   if tx.get(TxField.TYPE) == TX_TYPE_MONEY_IN]

        if not in_txs:
            return {'stat_cards': [], 'chart': None,
                    'meta': {'from': from_date.isoformat() if from_date else None,
                             'to':   to_date.isoformat()   if to_date   else None,
                             'currency': self.quote_currency}}

        by_source   = _group_income(in_txs, TxField.COUNTERPARTY, 'Unknown source', self.rate_map, self.quote_currency, sym)
        by_category = _group_income(in_txs, TxField.MAJOR_CATEGORY, 'Uncategorised', self.rate_map, self.quote_currency, sym)

        # Trend — monthly income totals
        month_keys = month_range(from_date, to_date)
        by_month   = group_by_month(in_txs)
        monthly    = [round(sum_amount_base(by_month.get(mk, []), self.rate_map, self.quote_currency), 2)
                      for mk in month_keys]
        total     = sum(monthly)
        avg       = round(total / len(month_keys), 2) if month_keys else 0.0
        peak_idx  = monthly.index(max(monthly)) if monthly else 0

        return {
            'stat_cards': [
                {'label': 'Total income',  'value': _fmt(total, sym),         'sub': '', 'class': 'positive'},
                {'label': 'Avg monthly',   'value': _fmt(avg, sym),           'sub': '', 'class': ''},
                {'label': 'Peak month',    'value': fmt_month_key(month_keys[peak_idx]) if month_keys else '—',
                 'sub': _fmt(monthly[peak_idx], sym) if monthly else '', 'class': ''},
                {'label': 'Sources',       'value': str(len(by_source['labels'])), 'sub': '', 'class': ''},
            ],
            'chart': {
                'by_source':   by_source,
                'by_category': by_category,
                'trend': {
                    'labels': [fmt_month_key(mk) for mk in month_keys],
                    'data':   monthly,
                },
            },
            'meta': {
                'from':     from_date.isoformat() if from_date else None,
                'to':       to_date.isoformat()   if to_date   else None,
                'currency': self.quote_currency,
            },
        }
