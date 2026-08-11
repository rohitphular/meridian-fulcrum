from datetime import date

from jobs.insights.base_insight import BaseInsight
from jobs.insights.data_utils import (
    currency_symbol, compute_daily_total_assets, is_active_account, TEAL,
)
from jobs.insights.insight_schema import AccountField

_LIABILITY_TYPES = {'liability', 'loan', 'credit_card', 'overdraft', 'mortgage'}


def _is_liability(a):
    return (a.get(AccountField.TYPE) or '').lower() in _LIABILITY_TYPES


def _is_investment(a):
    return (a.get(AccountField.TYPE) or '').lower() == 'investment'


def _fmt(v, sym):
    return f'{sym}{abs(v):,.0f}'


class D15AccountBalances(BaseInsight):
    insight_id     = '15-account-balances'
    periods        = ['default']
    derived_from   = ['default']
    chart_variants = ['']

    def compute(self, raw, from_date, to_date, derived_from, variant):
        today    = date.today()
        sym      = currency_symbol(self.quote_currency)
        all_txs  = raw['transactions']
        accounts = raw['accounts']

        active = [a for a in accounts if is_active_account(a)]
        if not active:
            return {'stat_cards': [], 'chart': None,
                    'meta': {'from': today.isoformat(), 'to': today.isoformat(),
                             'currency': self.quote_currency}}

        asset_accts = [a for a in active if not _is_liability(a) and not _is_investment(a)]
        liab_accts  = [a for a in active if _is_liability(a)]
        inv_accts   = [a for a in active if _is_investment(a)]

        def _bal(acct_list):
            if not acct_list:
                return []
            # Single-day range = today's balance
            daily = compute_daily_total_assets(acct_list, all_txs, today, today,
                                               self.rate_map, self.quote_currency)
            return [round(daily[0] if daily else 0.0, 2)]

        def _per_account(a):
            daily = compute_daily_total_assets([a], all_txs, today, today,
                                               self.rate_map, self.quote_currency)
            return round(daily[0] if daily else 0.0, 2)

        asset_balances = {a.get(AccountField.NAME, a.get(AccountField.ID)): _per_account(a) for a in asset_accts}
        liab_balances  = {a.get(AccountField.NAME, a.get(AccountField.ID)): _per_account(a) for a in liab_accts}
        inv_balances   = {a.get(AccountField.NAME, a.get(AccountField.ID)): _per_account(a) for a in inv_accts}

        total_assets = sum(asset_balances.values())
        total_liab   = sum(abs(v) for v in liab_balances.values())
        total_inv    = sum(inv_balances.values())
        net_worth    = total_assets + total_inv - total_liab

        nw_class = 'positive' if net_worth >= 0 else 'negative'

        return {
            'stat_cards': [
                {'label': 'Assets',      'value': _fmt(total_assets, sym), 'sub': '', 'class': 'positive'},
                {'label': 'Liabilities', 'value': _fmt(total_liab, sym),   'sub': '', 'class': 'negative'},
                {'label': 'Investments', 'value': _fmt(total_inv, sym),    'sub': '', 'class': 'positive'},
                {'label': 'Net worth',   'value': _fmt(net_worth, sym),    'sub': '', 'class': nw_class},
            ],
            'chart': {
                'assets': {
                    'labels': list(asset_balances.keys()),
                    'data':   [round(v, 2) for v in asset_balances.values()],
                    'color':  TEAL,
                },
                'liabilities': {
                    'labels': list(liab_balances.keys()),
                    'data':   [abs(round(v, 2)) for v in liab_balances.values()],
                    'color':  'rgba(248,113,113,0.8)',
                },
                'investments': {
                    'labels': list(inv_balances.keys()),
                    'data':   [round(v, 2) for v in inv_balances.values()],
                    'color':  'rgba(251,191,36,0.8)',
                },
            },
            'meta': {
                'from':     today.isoformat(),
                'to':       today.isoformat(),
                'currency': self.quote_currency,
            },
        }
