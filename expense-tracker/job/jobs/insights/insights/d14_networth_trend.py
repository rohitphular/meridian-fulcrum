import calendar
from datetime import date, timedelta

from jobs.insights.base_insight import BaseInsight
from jobs.insights.data_utils import (
    currency_symbol, compute_daily_total_assets, is_active_account,
    month_range, fmt_month_key, to_base, TEAL,
)
from jobs.insights.insight_schema import AccountField


def _fmt(v, sym):
    prefix = '−' if v < 0 else ''
    return f'{prefix}{sym}{abs(v):,.0f}'


def _month_end(year, month):
    _, last_day = calendar.monthrange(year, month)
    return date(year, month, last_day)


def _sample_month_end(daily, range_start, year, month):
    end = _month_end(year, month)
    idx = (end - range_start).days
    if not daily:
        return 0.0
    return round(daily[min(idx, len(daily) - 1)], 2)


class D14NetworthTrend(BaseInsight):
    insight_id     = '14-networth-trend'
    periods        = ['last_6', 'last_12', 'ytd', 'last_year']
    derived_from   = ['default']
    chart_variants = ['']

    def compute(self, raw, from_date, to_date, derived_from, variant):
        today    = date.today()
        sym      = currency_symbol(self.quote_currency)
        all_txs  = raw['transactions']
        accounts = raw['accounts']

        all_active = [a for a in accounts if is_active_account(a)]
        if not all_active:
            return {'stat_cards': [], 'chart': None,
                    'meta': {'from': from_date.isoformat() if from_date else None,
                             'to':   to_date.isoformat()   if to_date   else None,
                             'currency': self.quote_currency}}

        month_keys = month_range(from_date, to_date)
        range_start = from_date.replace(day=1)
        range_end   = _month_end(to_date.year, to_date.month) if to_date else today

        # One pass for the full period — all accounts (assets − liabilities via negative opening_value)
        daily = compute_daily_total_assets(all_active, all_txs, range_start, range_end,
                                           self.rate_map, self.quote_currency)

        monthly = []
        for mk in month_keys:
            y, m = map(int, mk.split('-'))
            monthly.append(_sample_month_end(daily, range_start, y, m))

        # Clamp last month to today if period is current
        if to_date and to_date >= today and monthly:
            today_idx = (today - range_start).days
            monthly[-1] = round(daily[min(today_idx, len(daily) - 1)] if daily else 0.0, 2)

        # 12-months-ago reference — always computed independently
        ref_date   = today.replace(day=1)
        ref_m      = ref_date.month - 12
        ref_y      = ref_date.year
        if ref_m <= 0:
            ref_m += 12
            ref_y -= 1
        ref_start  = date(ref_y, ref_m, 1)
        ref_end    = _month_end(ref_y, ref_m)
        daily_ref  = compute_daily_total_assets(all_active, all_txs, ref_start, ref_end,
                                                self.rate_map, self.quote_currency)
        nw_12m_ago = round(daily_ref[-1] if daily_ref else 0.0, 2)

        current     = monthly[-1] if monthly else 0.0
        prev        = monthly[-2] if len(monthly) >= 2 else 0.0
        delta_month = current - prev
        delta_12m   = current - nw_12m_ago
        pct_12m     = round(abs(delta_12m) / abs(nw_12m_ago) * 100) if nw_12m_ago else None
        pcts_12m    = f' ({pct_12m}%)' if pct_12m is not None else ''

        nw_class  = 'positive' if current >= 0 else 'negative'
        dm_class  = 'positive' if delta_month >= 0 else 'negative'
        d12_class = 'positive' if delta_12m >= 0 else 'negative'

        return {
            'stat_cards': [
                {'label': 'Net worth',        'value': _fmt(current, sym),      'sub': '', 'class': nw_class},
                {'label': 'Change this month','value': _fmt(delta_month, sym),  'sub': '', 'class': dm_class},
                {'label': 'vs 12 months ago', 'value': _fmt(delta_12m, sym),   'sub': pcts_12m, 'class': d12_class},
            ],
            'chart': {
                'labels': [fmt_month_key(mk) for mk in month_keys],
                'datasets': [{
                    'label':           'Net Worth',
                    'data':            monthly,
                    'borderColor':     TEAL,
                    'backgroundColor': TEAL + '18',
                    'fill':            'origin',
                }],
            },
            'meta': {
                'from':       from_date.isoformat() if from_date else None,
                'to':         to_date.isoformat()   if to_date   else None,
                'currency':   self.quote_currency,
                'nw_12m_ago': nw_12m_ago,
            },
        }
