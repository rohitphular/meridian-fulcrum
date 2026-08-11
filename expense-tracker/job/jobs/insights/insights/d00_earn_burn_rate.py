from datetime import date, timedelta

from jobs.insights.base_insight import BaseInsight
from jobs.insights.data_utils import currency_symbol, to_base, MONTH_ABBREV
from jobs.insights.insight_schema import TxField, TX_TYPE_MONEY_IN, TX_TYPE_MONEY_OUT


class D00EarnBurnRate(BaseInsight):
    insight_id     = '00-earn-burn-rate'
    periods        = ['last_3', 'last_6', 'last_12', 'ytd', 'last_year']
    derived_from   = ['default']
    chart_variants = ['7d', '14d', '30d', '90d']

    def compute(self, raw, from_date, to_date, derived_from, variant):
        window_days = int(variant.rstrip('d'))
        txs         = raw['transactions']
        sym         = currency_symbol(self.quote_currency)

        # Build per-day earn/burn maps from ALL transactions (not period-filtered),
        # so the trailing window can reach before from_date.
        earn_by_day = {}
        burn_by_day = {}

        for tx in txs:
            dt_str = tx.get(TxField.DATE_TIME, '')
            if not dt_str:
                continue
            try:
                d = date.fromisoformat(str(dt_str)[:10])
            except ValueError:
                continue

            amt = to_base(
                tx.get(TxField.AMOUNT),
                tx.get(TxField.CURRENCY),
                tx.get(TxField.FX_RATE),
                self.rate_map,
                self.quote_currency,
            )
            if not amt or amt != amt:  # skip zero and NaN
                continue

            key      = d.isoformat()
            tx_type  = tx.get(TxField.TYPE, '')
            if tx_type == TX_TYPE_MONEY_IN:
                earn_by_day[key] = earn_by_day.get(key, 0.0) + amt
            elif tx_type == TX_TYPE_MONEY_OUT:
                burn_by_day[key] = burn_by_day.get(key, 0.0) + amt

        today  = date.today()
        end    = min(to_date, today) if to_date else today
        cursor = from_date

        labels        = []
        income_rates  = []
        expense_rates = []
        savings_rates = []

        while cursor <= end:
            labels.append(f'{cursor.day} {MONTH_ABBREV[cursor.month - 1]}')

            earn_sum = 0.0
            burn_sum = 0.0
            for i in range(window_days):
                k         = (cursor - timedelta(days=i)).isoformat()
                earn_sum += earn_by_day.get(k, 0.0)
                burn_sum += burn_by_day.get(k, 0.0)

            income_rates.append(round(earn_sum  / window_days, 6))
            expense_rates.append(round(burn_sum  / window_days, 6))
            savings_rates.append(round((earn_sum - burn_sum) / window_days, 6))

            cursor += timedelta(days=1)

        last_income  = income_rates[-1]  if income_rates  else 0.0
        last_expense = expense_rates[-1] if expense_rates else 0.0
        last_savings = savings_rates[-1] if savings_rates else 0.0
        sav_class    = 'positive' if last_savings >= 0 else 'negative'
        savings_pct  = round((last_savings / last_income) * 100, 1) if last_income > 0 else None

        def fmt(v):
            return f'{sym}{abs(v):,.2f}'

        def fmt_signed(v):
            sign = '+' if v >= 0 else '−'
            return f'{sign}{sym}{abs(v):,.2f}'

        stat_cards = [
            {
                'label': 'Savings / day',
                'value': fmt_signed(last_savings),
                'sub':   f'{window_days}d trailing avg',
                'class': sav_class,
            },
            {
                'label': 'Income / day',
                'value': fmt(last_income),
                'sub':   f'{window_days}d trailing avg',
                'class': 'positive',
            },
            {
                'label': 'Expense / day',
                'value': fmt(last_expense),
                'sub':   f'{window_days}d trailing avg',
                'class': 'negative',
            },
            {
                'label': 'Savings rate',
                'value': f'{savings_pct}%' if savings_pct is not None else '—',
                'sub':   'of income',
                'class': sav_class,
            },
        ]

        return {
            'stat_cards': stat_cards,
            'chart': {
                'labels': labels,
                'datasets': [
                    {
                        'label':       'Income rate',
                        'data':        income_rates,
                        'borderColor': '#34d399',
                    },
                    {
                        'label':       'Expense rate',
                        'data':        expense_rates,
                        'borderColor': '#f87171',
                    },
                    {
                        'label':       'Savings rate',
                        'data':        savings_rates,
                        'borderColor': '#60a5fa',
                    },
                ],
            },
            'meta': {
                'from':        from_date.isoformat() if from_date else None,
                'to':          end.isoformat(),
                'currency':    self.quote_currency,
                'window_days': window_days,
            },
        }
