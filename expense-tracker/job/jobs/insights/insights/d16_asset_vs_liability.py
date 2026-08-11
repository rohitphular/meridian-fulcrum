import calendar
from datetime import date

from jobs.insights.base_insight import BaseInsight
from jobs.insights.data_utils import (
    currency_symbol, compute_daily_total_assets, is_active_account,
    month_range, fmt_month_key, TEAL,
)
from jobs.insights.insight_schema import AccountField

_LIABILITY_TYPES = {'liability', 'loan', 'credit_card', 'overdraft', 'mortgage'}


def _is_liability(a):
    return (a.get(AccountField.TYPE) or '').lower() in _LIABILITY_TYPES


def _month_end(year, month):
    _, last_day = calendar.monthrange(year, month)
    return date(year, month, last_day)


def _sample_month_end(daily, range_start, year, month):
    end = _month_end(year, month)
    idx = (end - range_start).days
    if not daily:
        return 0.0
    return round(daily[min(idx, len(daily) - 1)], 2)


def _fmt(v, sym):
    prefix = '−' if v < 0 else ''
    return f'{prefix}{sym}{abs(v):,.0f}'


class D16AssetVsLiability(BaseInsight):
    insight_id     = '16-asset-vs-liability'
    periods        = ['last_6', 'last_12', 'ytd', 'last_year']
    derived_from   = ['default']
    chart_variants = ['']

    def compute(self, raw, from_date, to_date, derived_from, variant):
        today    = date.today()
        sym      = currency_symbol(self.quote_currency)
        all_txs  = raw['transactions']
        accounts = raw['accounts']

        active      = [a for a in accounts if is_active_account(a)]
        asset_accts = [a for a in active if not _is_liability(a)]
        liab_accts  = [a for a in active if _is_liability(a)]

        if not active:
            return {'stat_cards': [], 'chart': None,
                    'meta': {'from': from_date.isoformat() if from_date else None,
                             'to':   to_date.isoformat()   if to_date   else None,
                             'currency': self.quote_currency}}

        month_keys  = month_range(from_date, to_date)
        range_start = from_date.replace(day=1)
        range_end   = _month_end(to_date.year, to_date.month)

        daily_assets = compute_daily_total_assets(asset_accts, all_txs, range_start, range_end,
                                                  self.rate_map, self.quote_currency) if asset_accts else []
        daily_liabs  = compute_daily_total_assets(liab_accts,  all_txs, range_start, range_end,
                                                  self.rate_map, self.quote_currency) if liab_accts else []

        asset_monthly = []
        liab_monthly  = []
        for mk in month_keys:
            y, m = map(int, mk.split('-'))
            asset_monthly.append(_sample_month_end(daily_assets, range_start, y, m) if daily_assets else 0.0)
            liab_monthly.append(abs(_sample_month_end(daily_liabs, range_start, y, m)) if daily_liabs else 0.0)

        cur_assets = asset_monthly[-1] if asset_monthly else 0.0
        cur_liabs  = liab_monthly[-1]  if liab_monthly  else 0.0
        cur_nw     = cur_assets - cur_liabs
        first_nw   = (asset_monthly[0] if asset_monthly else 0.0) - (liab_monthly[0] if liab_monthly else 0.0)
        delta_nw   = cur_nw - first_nw

        nw_class    = 'positive' if cur_nw   >= 0 else 'negative'
        delta_class = 'positive' if delta_nw >= 0 else 'negative'

        return {
            'stat_cards': [
                {'label': 'Total assets',      'value': _fmt(cur_assets, sym), 'sub': '', 'class': 'positive'},
                {'label': 'Total liabilities', 'value': _fmt(cur_liabs, sym),  'sub': '', 'class': 'negative'},
                {'label': 'Net worth',         'value': _fmt(cur_nw, sym),     'sub': '', 'class': nw_class},
                {'label': 'Period Δ net',      'value': _fmt(delta_nw, sym),   'sub': '', 'class': delta_class},
            ],
            'chart': {
                'labels': [fmt_month_key(mk) for mk in month_keys],
                'datasets': [
                    {'label': 'Total Assets',      'data': asset_monthly, 'borderColor': TEAL,
                     'backgroundColor': TEAL + '1a', 'fill': True},
                    {'label': 'Total Liabilities', 'data': liab_monthly,  'borderColor': '#f87171',
                     'backgroundColor': '#f8717118', 'fill': True, 'borderDash': [4, 4]},
                ],
            },
            'meta': {
                'from':     from_date.isoformat() if from_date else None,
                'to':       to_date.isoformat()   if to_date   else None,
                'currency': self.quote_currency,
            },
        }
