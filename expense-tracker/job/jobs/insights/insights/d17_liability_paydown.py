import calendar
from datetime import date

from jobs.insights.base_insight import BaseInsight
from jobs.insights.data_utils import (
    currency_symbol, compute_daily_total_assets, is_active_account,
    month_range, fmt_month_key, PALETTE,
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


def _project_payoff(balances_abs):
    if len(balances_abs) < 2:
        return None
    tail = balances_abs[-3:]
    reductions = [tail[i] - tail[i + 1] for i in range(len(tail) - 1) if tail[i] - tail[i + 1] > 0]
    if not reductions:
        return None
    avg = sum(reductions) / len(reductions)
    current = balances_abs[-1]
    if current <= 0:
        return {'months': 0}
    months = -(-int(current // avg) + (1 if current % avg > 0 else 0))  # ceiling division
    return {'months': max(1, months)}


def _payoff_date_str(months):
    today = date.today()
    m = today.month + months
    y = today.year
    while m > 12:
        m -= 12
        y += 1
    return date(y, m, 1).strftime('%b %Y')


def _fmt(v, sym):
    return f'{sym}{abs(v):,.0f}'


class D17LiabilityPaydown(BaseInsight):
    insight_id     = '17-liability-paydown'
    periods        = ['last_6', 'last_12', 'ytd', 'last_year']
    derived_from   = ['default']
    chart_variants = ['']

    def compute(self, raw, from_date, to_date, derived_from, variant):
        today    = date.today()
        sym      = currency_symbol(self.quote_currency)
        all_txs  = raw['transactions']
        accounts = raw['accounts']

        liab_accts = [a for a in accounts if is_active_account(a) and _is_liability(a)]
        if not liab_accts:
            return {'stat_cards': [], 'chart': None,
                    'meta': {'from': from_date.isoformat() if from_date else None,
                             'to':   to_date.isoformat()   if to_date   else None,
                             'currency': self.quote_currency}}

        month_keys  = month_range(from_date, to_date)
        range_start = from_date.replace(day=1)
        range_end   = _month_end(to_date.year, to_date.month)

        all_balances   = {}   # account_id → [abs monthly balance]
        account_labels = {}
        for a in liab_accts:
            acc_id = a.get(AccountField.ID)
            name   = a.get(AccountField.NAME, acc_id)
            daily  = compute_daily_total_assets([a], all_txs, range_start, range_end,
                                                self.rate_map, self.quote_currency)
            monthly = []
            for mk in month_keys:
                y, m  = map(int, mk.split('-'))
                raw_v = _sample_month_end(daily, range_start, y, m)
                monthly.append(abs(raw_v))
            all_balances[acc_id]   = monthly
            account_labels[acc_id] = name

        # Build datasets
        datasets = []
        for i, a in enumerate(liab_accts):
            acc_id = a.get(AccountField.ID)
            label  = account_labels[acc_id]
            label  = label[:15] + '…' if len(label) > 15 else label
            datasets.append({
                'label':           label,
                'data':            all_balances[acc_id],
                'borderColor':     PALETTE[i % len(PALETTE)],
                'backgroundColor': PALETTE[i % len(PALETTE)] + '22',
                'tension':         0.3,
                'pointRadius':     4,
                'hidden':          i >= 6,
            })

        total_current = sum(m[-1] for m in all_balances.values())
        total_opening = sum(abs(float(a.get(AccountField.OPENING_VALUE) or 0)) for a in liab_accts)
        overall_paid  = round((1 - total_current / total_opening) * 100) if total_opening else None

        # Progress bar data per account
        progress = []
        for a in liab_accts:
            acc_id  = a.get(AccountField.ID)
            opening = abs(float(a.get(AccountField.OPENING_VALUE) or 0))
            current = all_balances[acc_id][-1] if all_balances[acc_id] else 0.0
            pct     = round((1 - current / opening) * 100) if opening else None
            payoff  = _project_payoff(all_balances[acc_id])
            payoff_str = None
            if payoff:
                payoff_str = 'Fully paid off' if payoff['months'] == 0 else _payoff_date_str(payoff['months'])
            progress.append({
                'name':       a.get(AccountField.NAME, acc_id),
                'current':    round(current, 2),
                'pct_paid':   pct,
                'payoff':     payoff_str,
            })

        return {
            'stat_cards': [
                {'label': 'Outstanding',  'value': _fmt(total_current, sym), 'sub': '', 'class': 'negative'},
                {'label': 'Started with', 'value': _fmt(total_opening, sym) if total_opening else '—', 'sub': '', 'class': ''},
                {'label': 'Overall paid', 'value': f'{overall_paid}%' if overall_paid is not None else 'N/A', 'sub': '', 'class': 'positive'},
                {'label': 'Accounts',     'value': str(len(liab_accts)), 'sub': '', 'class': ''},
            ],
            'chart': {
                'labels':   [fmt_month_key(mk) for mk in month_keys],
                'datasets': datasets,
            },
            'meta': {
                'from':     from_date.isoformat() if from_date else None,
                'to':       to_date.isoformat()   if to_date   else None,
                'currency': self.quote_currency,
                'progress': progress,
            },
        }
