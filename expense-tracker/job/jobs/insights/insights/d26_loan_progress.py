from datetime import date

from jobs.insights.base_insight import BaseInsight
from jobs.insights.data_utils import (
    currency_symbol, compute_daily_total_assets, is_active_account, TEAL,
)
from jobs.insights.insight_schema import AccountField, TxField, TX_TYPE_MONEY_TRANSFER

_LIABILITY_TYPES = {'liability', 'loan', 'credit_card', 'overdraft', 'mortgage'}


def _is_liability(a):
    return (a.get(AccountField.TYPE) or '').lower() in _LIABILITY_TYPES


def _months_since(d_str, today):
    if not d_str:
        return 1
    try:
        d = date.fromisoformat(str(d_str)[:10])
        months = (today.year - d.year) * 12 + (today.month - d.month)
        return max(1, months)
    except ValueError:
        return 1


def _payoff_date_str(months):
    today = date.today()
    m = today.month + months
    y = today.year
    while m > 12:
        m -= 12
        y += 1
    return date(y, m, 1).strftime('%B %Y')


def _fmt(v, sym):
    return f'{sym}{abs(v):,.0f}'


class D26LoanProgress(BaseInsight):
    insight_id     = '26-loan-progress'
    periods        = ['default']
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
                    'meta': {'from': today.isoformat(), 'to': today.isoformat(),
                             'currency': self.quote_currency}}

        loans = []
        for a in liab_accts:
            acc_id   = a.get(AccountField.ID)
            name     = a.get(AccountField.NAME, acc_id)
            opening  = abs(float(a.get(AccountField.OPENING_VALUE) or 0))

            daily    = compute_daily_total_assets([a], all_txs, today, today,
                                                  self.rate_map, self.quote_currency)
            current  = abs(round(daily[0] if daily else 0.0, 2))
            repaid   = max(0.0, round(opening - current, 2))
            pct_paid = round(repaid / opening * 100) if opening > 0 else None

            # Repayment transactions (transfers targeting this account)
            repay_txs = [tx for tx in all_txs
                         if tx.get(TxField.TYPE) == TX_TYPE_MONEY_TRANSFER
                         and tx.get(TxField.TARGET_ACCOUNT) == acc_id]
            months_since = _months_since(a.get('opening_date'), today)
            avg_monthly  = round(repaid / months_since, 2) if months_since > 0 else 0.0

            months_to_payoff = None
            payoff_str       = None
            if current <= 0:
                payoff_str = 'Paid off'
            elif avg_monthly > 0:
                months_to_payoff = -(-int(current) // int(avg_monthly)) if avg_monthly >= 1 else None
                if months_to_payoff:
                    payoff_str = f'{_payoff_date_str(months_to_payoff)} (~{months_to_payoff} mo)'

            loans.append({
                'name':           name,
                'acc_id':         acc_id,
                'type':           a.get(AccountField.TYPE),
                'currency':       a.get(AccountField.CURRENCY),
                'opening':        round(opening, 2),
                'current':        current,
                'repaid':         repaid,
                'pct_paid':       pct_paid,
                'avg_monthly':    avg_monthly,
                'payoff_str':     payoff_str,
                'bal_increased':  current > opening and opening > 0,
                'repay_count':    len(repay_txs),
            })

        total_debt    = sum(l['current']     for l in loans)
        total_repaid  = sum(l['repaid']      for l in loans)
        total_monthly = sum(l['avg_monthly'] for l in loans)
        earliest = min((l for l in loans if l['payoff_str'] and l['payoff_str'] != 'Paid off'),
                       key=lambda l: l.get('payoff_str', 'zzz'), default=None)

        return {
            'stat_cards': [
                {'label': 'Total debt',      'value': _fmt(total_debt, sym),    'sub': '', 'class': 'negative'},
                {'label': 'Total repaid',    'value': _fmt(total_repaid, sym),  'sub': '', 'class': 'positive'},
                {'label': 'Monthly burden',  'value': _fmt(total_monthly, sym), 'sub': '', 'class': ''},
                {'label': 'Earliest payoff', 'value': earliest['name'] if earliest else '—',
                 'sub': earliest['payoff_str'] if earliest else '', 'class': ''},
            ],
            'chart': None,
            'meta': {
                'from':     today.isoformat(),
                'to':       today.isoformat(),
                'currency': self.quote_currency,
                'loans':    loans,
            },
        }
