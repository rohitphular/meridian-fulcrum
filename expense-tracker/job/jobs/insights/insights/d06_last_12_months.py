import calendar
from datetime import date, timedelta

from jobs.insights.base_insight import BaseInsight
from jobs.insights.data_utils import (
    currency_symbol, sum_amount_base, group_by_month,
    compute_daily_total_assets, is_active_account, tx_date,
    filter_by_range, PALETTE, MONTH_ABBREV,
)
from jobs.insights.insight_schema import TxField, AccountField, TX_TYPE_MONEY_IN, TX_TYPE_MONEY_OUT


def _fmt(v, sym):
    return f'{sym}{abs(v):,.0f}'


def _window12(today):
    months = []
    for i in range(12):
        raw_m = today.month - 11 + i
        y = today.year
        while raw_m <= 0:
            raw_m += 12
            y -= 1
        while raw_m > 12:
            raw_m -= 12
            y += 1
        months.append(date(y, raw_m, 1))
    return months


class D06Last12Months(BaseInsight):
    insight_id     = '06-last-12-months'
    periods        = ['default']
    derived_from   = ['transactions', 'accounts']
    chart_variants = ['']

    def compute(self, raw, from_date, to_date, derived_from, variant):
        today    = date.today()
        sym      = currency_symbol(self.quote_currency)
        all_txs  = raw['transactions']
        accounts = raw['accounts']

        months12 = _window12(today)

        if derived_from == 'transactions':
            return self._transactions(all_txs, months12, today, sym)
        return self._accounts(accounts, all_txs, months12, today, sym)

    def _transactions(self, all_txs, months12, today, sym):
        by_month = group_by_month(all_txs)
        income   = []
        expense  = []
        net      = []

        for i, month_start in enumerate(months12):
            yr  = month_start.year
            mo  = month_start.month
            key = f'{yr}-{mo:02d}'
            all_m = by_month.get(key, [])

            # Last bucket: partial month up to today
            txs = [tx for tx in all_m if tx_date(tx) is not None and tx_date(tx) <= today] if i == 11 else all_m

            inc = sum_amount_base([tx for tx in txs if tx.get(TxField.TYPE) == TX_TYPE_MONEY_IN],
                                  self.rate_map, self.quote_currency)
            exp = sum_amount_base([tx for tx in txs if tx.get(TxField.TYPE) == TX_TYPE_MONEY_OUT],
                                  self.rate_map, self.quote_currency)
            income.append(round(inc, 2))
            expense.append(round(exp, 2))
            net.append(round(inc - exp, 2))

        total_income  = sum(income)
        total_expense = sum(expense)
        total_net     = total_income - total_expense
        avg_monthly   = total_expense / 12

        # Labels: "Aug 26", last one marked as partial with *
        labels = []
        for i, m in enumerate(months12):
            abbrev = f'{MONTH_ABBREV[m.month - 1]} {str(m.year)[2:]}'
            labels.append(f'{abbrev}*' if i == 11 else abbrev)

        net_class = 'positive' if total_net >= 0 else 'negative'
        net_arrow = '↑' if total_net >= 0 else '↓'

        range_from = months12[0]
        return {
            'stat_cards': [
                {'label': 'Income (12 mo)',   'value': _fmt(total_income, sym),  'sub': '', 'class': 'positive'},
                {'label': 'Expenses (12 mo)', 'value': _fmt(total_expense, sym), 'sub': '', 'class': 'negative'},
                {'label': 'Net', 'value': f'{net_arrow} {_fmt(abs(total_net), sym)}', 'sub': '', 'class': net_class},
                {'label': 'Avg spend/mo', 'value': _fmt(avg_monthly, sym), 'sub': '', 'class': ''},
            ],
            'chart': {
                'labels': labels,
                'datasets': [
                    {'label': 'Income',   'data': income,  'backgroundColor': 'rgba(52,211,153,0.8)'},
                    {'label': 'Expenses', 'data': expense, 'backgroundColor': 'rgba(248,113,113,0.8)'},
                    {'label': 'Net',      'data': net,     'borderColor': '#f59e0b', 'type': 'line'},
                ],
            },
            'meta': {'from': range_from.isoformat(), 'to': today.isoformat(), 'currency': self.quote_currency},
        }

    def _accounts(self, accounts, all_txs, months12, today, sym):
        asset_accts = [a for a in accounts if is_active_account(a) and a.get(AccountField.TYPE) != 'liability']
        if not asset_accts:
            return {'stat_cards': [], 'chart': None,
                    'meta': {'from': months12[0].isoformat(), 'to': today.isoformat(), 'currency': self.quote_currency}}

        range_start = months12[0]

        # Group accounts by sub_type → type → 'other'
        groups = {}
        for a in asset_accts:
            key = a.get(AccountField.SUB_TYPE) or a.get(AccountField.TYPE) or 'other'
            groups.setdefault(key, []).append(a)

        daily_cache = {}   # group_key → list of daily totals
        for group_key, group_accts in groups.items():
            daily_cache[group_key] = compute_daily_total_assets(
                group_accts, all_txs, range_start, today, self.rate_map, self.quote_currency
            )

        datasets = []
        for i, (group_key, daily) in enumerate(daily_cache.items()):
            data = []
            for j, month_start in enumerate(months12):
                is_last = j == 11
                if is_last:
                    sample = today
                else:
                    _, last_day = calendar.monthrange(month_start.year, month_start.month)
                    sample = date(month_start.year, month_start.month, last_day)
                idx = (sample - range_start).days
                data.append(round(daily[min(idx, len(daily) - 1)] if daily else 0.0, 2))
            label = group_key.replace('_', ' ').capitalize()
            datasets.append({
                'label':           label,
                'data':            data,
                'backgroundColor': PALETTE[i % len(PALETTE)] + 'cc',
            })

        total_assets = sum(ds['data'][-1] for ds in datasets)
        group_names  = ', '.join(gk for gk in daily_cache)

        labels = []
        for i, m in enumerate(months12):
            abbrev = f'{MONTH_ABBREV[m.month - 1]} {str(m.year)[2:]}'
            labels.append(f'{abbrev}*' if i == 11 else abbrev)

        return {
            'stat_cards': [
                {'label': 'Total assets',   'value': _fmt(total_assets, sym), 'sub': '', 'class': ''},
                {'label': 'Account groups', 'value': str(len(groups)),       'sub': group_names, 'class': ''},
            ],
            'chart': {
                'labels': labels,
                'datasets': datasets,
            },
            'meta': {'from': range_start.isoformat(), 'to': today.isoformat(), 'currency': self.quote_currency},
        }
