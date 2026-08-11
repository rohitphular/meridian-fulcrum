import calendar
from datetime import date

from jobs.insights.base_insight import BaseInsight
from jobs.insights.data_utils import (
    currency_symbol, filter_by_range, sum_amount_base, compute_daily_total_assets,
    is_active_account, group_by_month, month_range, fmt_month_key, TEAL,
)
from jobs.insights.insight_schema import TxField, AccountField, TX_TYPE_MONEY_IN

_LIABILITY_TYPES = {'liability', 'loan', 'credit_card', 'overdraft', 'mortgage'}


def _is_liability(a):
    return (a.get(AccountField.TYPE) or '').lower() in _LIABILITY_TYPES


def _month_end(year, month):
    _, last_day = calendar.monthrange(year, month)
    return date(year, month, last_day)


def _fmt(v, sym):
    return f'{sym}{abs(v):,.0f}'


def _dti_status(ratio):
    if ratio is None:
        return 'N/A', '#94a3b8'
    if ratio < 20:  return 'Excellent', '#34d399'
    if ratio < 36:  return 'Good',      '#14b8a6'
    if ratio < 50:  return 'Caution',   '#f59e0b'
    return 'High risk', '#f87171'


class D27DebtToIncome(BaseInsight):
    insight_id     = '27-debt-to-income'
    periods        = ['last_6', 'last_12', 'ytd', 'last_year']
    derived_from   = ['default']
    chart_variants = ['']

    def compute(self, raw, from_date, to_date, derived_from, variant):
        today    = date.today()
        sym      = currency_symbol(self.quote_currency)
        all_txs  = raw['transactions']
        accounts = raw['accounts']

        liab_accts = [a for a in accounts if is_active_account(a) and _is_liability(a)]

        # Current total debt (today's balance)
        if liab_accts:
            daily_now = compute_daily_total_assets(liab_accts, all_txs, today, today,
                                                   self.rate_map, self.quote_currency)
            total_debt = round(abs(daily_now[0] if daily_now else 0.0), 2)
        else:
            total_debt = 0.0

        # Monthly income from complete calendar months in period
        month_keys = month_range(from_date, to_date)
        cur_mk     = f'{today.year}-{today.month:02d}'
        complete_mks = [mk for mk in month_keys if mk != cur_mk]
        if not complete_mks:
            complete_mks = month_keys  # fallback

        in_txs   = [tx for tx in filter_by_range(all_txs, from_date, to_date)
                    if tx.get(TxField.TYPE) == TX_TYPE_MONEY_IN]
        by_month = group_by_month(in_txs)
        monthly_inc_vals = [sum_amount_base(by_month.get(mk, []), self.rate_map, self.quote_currency)
                            for mk in complete_mks]
        non_zero = [v for v in monthly_inc_vals if v > 0]
        avg_monthly_inc  = sum(non_zero) / len(non_zero) if non_zero else 0.0
        annualised_inc   = round(avg_monthly_inc * 12, 2)

        dti_ratio        = round(total_debt / annualised_inc * 100, 1) if annualised_inc > 0 else None
        status, color    = _dti_status(dti_ratio)

        # Monthly DTI trend
        range_start = from_date.replace(day=1)
        range_end   = _month_end(to_date.year, to_date.month)
        daily_liab  = compute_daily_total_assets(liab_accts, all_txs, range_start, range_end,
                                                 self.rate_map, self.quote_currency) if liab_accts else []

        dti_trend = []
        for i, mk in enumerate(month_keys):
            y, m = map(int, mk.split('-'))
            end  = _month_end(y, m)
            idx  = (end - range_start).days
            debt_m = abs(daily_liab[min(idx, len(daily_liab) - 1)] if daily_liab else 0.0)

            inc_complete = [mk2 for mk2 in month_keys[:i + 1] if mk2 != cur_mk]
            if inc_complete:
                inc_m = [sum_amount_base(by_month.get(mk2, []), self.rate_map, self.quote_currency)
                         for mk2 in inc_complete]
                non_z = [v for v in inc_m if v > 0]
                avg_m = sum(non_z) / len(non_z) if non_z else 0.0
                ann_m = avg_m * 12
            else:
                ann_m = 0.0

            dti_trend.append(round(debt_m / ann_m * 100, 1) if ann_m > 0 else None)

        # Income bar data
        monthly_inc_all = [round(sum_amount_base(by_month.get(mk, []), self.rate_map, self.quote_currency), 2)
                           for mk in month_keys]
        total_inc = round(sum(monthly_inc_all), 2)
        peak_idx  = monthly_inc_all.index(max(monthly_inc_all)) if monthly_inc_all else 0

        return {
            'stat_cards': [
                {'label': 'Total debt',         'value': _fmt(total_debt, sym),    'sub': '', 'class': 'negative'},
                {'label': 'Monthly income (avg)','value': _fmt(avg_monthly_inc, sym),'sub': '', 'class': ''},
                {'label': 'Annualised income',   'value': _fmt(annualised_inc, sym),'sub': '', 'class': ''},
                {'label': 'DTI ratio',
                 'value': f'{dti_ratio}%' if dti_ratio is not None else 'N/A',
                 'sub': status, 'class': ''},
            ],
            'chart': {
                'labels': [fmt_month_key(mk) for mk in month_keys],
                'gauge': {
                    'value': min(dti_ratio, 100) if dti_ratio is not None else 0,
                    'label': f'{dti_ratio}%' if dti_ratio is not None else 'N/A',
                    'status': status,
                    'color':  color,
                },
                'dti_trend': {
                    'data': dti_trend,
                    'borderColor': color,
                },
                'income_bars': {
                    'data':   monthly_inc_all,
                    'total':  total_inc,
                    'avg':    round(avg_monthly_inc, 2),
                    'peak_mk': month_keys[peak_idx] if month_keys else None,
                },
            },
            'meta': {
                'from':     from_date.isoformat() if from_date else None,
                'to':       to_date.isoformat()   if to_date   else None,
                'currency': self.quote_currency,
                'dti':      dti_ratio,
                'status':   status,
            },
        }
