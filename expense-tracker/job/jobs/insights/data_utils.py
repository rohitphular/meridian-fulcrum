import calendar
from collections import defaultdict
from datetime import date, timedelta

from jobs.insights.insight_schema import (
    TxField, AccountField,
    TX_TYPE_MONEY_IN, TX_TYPE_MONEY_OUT, TX_TYPE_MONEY_TRANSFER,
)

_CURRENCY_SYMBOLS = {
    'GBP': '£', 'USD': '$', 'EUR': '€', 'INR': '₹',
    'AUD': 'A$', 'CAD': 'C$', 'JPY': '¥', 'CHF': 'CHF ',
    'SGD': 'S$', 'HKD': 'HK$', 'AED': 'AED ', 'NZD': 'NZ$',
}

MONTH_ABBREV = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']


def currency_symbol(currency):
    return _CURRENCY_SYMBOLS.get(currency, currency + ' ')


def to_base(amount, currency, fx_rate, rate_map, quote_currency):
    """Convert amount from currency to quote_currency.

    Mirrors toBase() in forge/_shared/utils.js.
    Uses fx_rate if present, otherwise rate_map lookup.
    """
    amt = float(amount or 0)
    to  = rate_map.get(quote_currency)
    if not to:
        return amt
    if fx_rate:
        try:
            fx = float(fx_rate)
            if fx > 0:
                return (amt / fx) * to
        except (ValueError, TypeError):
            pass
    frm = rate_map.get(currency)
    if not frm:
        return amt
    return (amt / frm) * to


def tx_date(tx):
    dt_str = tx.get(TxField.DATE_TIME, '')
    if not dt_str:
        return None
    try:
        return date.fromisoformat(str(dt_str)[:10])
    except ValueError:
        return None


def filter_by_range(txs, from_date, to_date):
    result = []
    for tx in txs:
        d = tx_date(tx)
        if d is None:
            continue
        if from_date and d < from_date:
            continue
        if to_date and d > to_date:
            continue
        result.append(tx)
    return result


def sum_amount_base(txs, rate_map, quote_currency):
    total = 0.0
    for tx in txs:
        v = to_base(
            tx.get(TxField.AMOUNT),
            tx.get(TxField.CURRENCY),
            tx.get(TxField.FX_RATE),
            rate_map,
            quote_currency,
        )
        if v and not (v != v):  # skip NaN
            total += v
    return total


def group_by_day(txs):
    groups = defaultdict(list)
    for tx in txs:
        d = tx_date(tx)
        if d:
            groups[d.isoformat()].append(tx)
    return dict(groups)


def group_by_month(txs):
    groups = defaultdict(list)
    for tx in txs:
        d = tx_date(tx)
        if d:
            groups[f'{d.year}-{d.month:02d}'].append(tx)
    return dict(groups)


def group_by_week(txs):
    groups = defaultdict(list)
    for tx in txs:
        d = tx_date(tx)
        if d:
            iso_year, iso_week, _ = d.isocalendar()
            groups[f'{iso_year}-W{iso_week:02d}'].append(tx)
    return dict(groups)


def month_range(from_date, to_date):
    months = []
    cursor = from_date.replace(day=1)
    end    = to_date.replace(day=1)
    while cursor <= end:
        months.append(f'{cursor.year}-{cursor.month:02d}')
        if cursor.month == 12:
            cursor = cursor.replace(year=cursor.year + 1, month=1)
        else:
            cursor = cursor.replace(month=cursor.month + 1)
    return months


def fmt_month_key(yyyy_mm):
    y, m = map(int, yyyy_mm.split('-'))
    return date(y, m, 1).strftime('%b')


# ── Chart colour constants ────────────────────────────────────────────────────
# Period A uses teal, Period B uses amber (fixed; matches JS CSS-variable values).
TEAL  = '#14b8a6'
AMBER = '#f59e0b'
PALETTE = [TEAL, AMBER, '#f87171', '#8b5cf6', '#3b82f6', '#10b981', '#f97316', '#94a3b8']


def is_active_account(account):
    v = str(account.get(AccountField.IS_ACTIVE, '')).upper().strip()
    return v in ('TRUE', '1', 'YES')


def compute_daily_total_assets(asset_accounts, all_txs, from_date, to_date, rate_map, quote_currency):
    """Replay all transactions to produce one total-asset value per calendar day in [from_date, to_date].

    Mirrors computeDailyTotalAssets() in insight-utils.js.
    Starts from each account's opening_value and applies ALL sorted transactions
    (including those before from_date) up to each day's end.
    """
    account_ids = {a.get(AccountField.ID) for a in asset_accounts}
    balance = {}
    for a in asset_accounts:
        acc_id = a.get(AccountField.ID)
        if acc_id:
            balance[acc_id] = to_base(
                float(a.get(AccountField.OPENING_VALUE) or 0),
                a.get(AccountField.CURRENCY),
                None,
                rate_map,
                quote_currency,
            )

    # Pre-filter bad dates, sort by date object (avoids string sort issues)
    dated = [(tx, tx_date(tx)) for tx in all_txs]
    dated = [(tx, d) for tx, d in dated if d is not None]
    dated.sort(key=lambda x: x[1])

    num_days = (to_date - from_date).days + 1
    daily_totals = []
    tx_idx = 0
    cursor = from_date

    for _ in range(num_days):
        while tx_idx < len(dated):
            tx, d = dated[tx_idx]
            if d > cursor:
                break
            amt = to_base(
                float(tx.get(TxField.AMOUNT) or 0),
                tx.get(TxField.CURRENCY),
                tx.get(TxField.FX_RATE),
                rate_map,
                quote_currency,
            )
            tx_type = tx.get(TxField.TYPE, '')
            src = tx.get(TxField.SOURCE_ACCOUNT)
            tgt = tx.get(TxField.TARGET_ACCOUNT)
            if tx_type == TX_TYPE_MONEY_OUT and src in account_ids:
                balance[src] = balance.get(src, 0.0) - amt
            elif tx_type == TX_TYPE_MONEY_IN and tgt in account_ids:
                balance[tgt] = balance.get(tgt, 0.0) + amt
            elif tx_type == TX_TYPE_MONEY_TRANSFER:
                if src in account_ids:
                    balance[src] = balance.get(src, 0.0) - amt
                if tgt in account_ids:
                    balance[tgt] = balance.get(tgt, 0.0) + amt
            tx_idx += 1

        daily_totals.append(sum(balance.values()))
        cursor += timedelta(days=1)

    return daily_totals


def build_cumulative(txs, start_date, num_days, cutoff_day, rate_map, quote_currency):
    """Running daily cumulative total.

    cutoff_day: 1-indexed day; entries beyond this → None (for current-period partial months/quarters).
    """
    by_day = group_by_day(txs)
    result = []
    running = 0.0
    for d in range(1, num_days + 1):
        if cutoff_day is not None and d > cutoff_day:
            result.append(None)
        else:
            key      = (start_date + timedelta(days=d - 1)).isoformat()
            running += sum_amount_base(by_day.get(key, []), rate_map, quote_currency)
            result.append(round(running, 2))
    return result


def build_monthly_cumulative(txs, year, num_months, partial_to, rate_map, quote_currency):
    """Running monthly cumulative total.

    partial_to: if not None, the last month is filtered to only include txs up to this date.
    """
    by_month = group_by_month(txs)
    running  = 0.0
    result   = []
    for m in range(1, num_months + 1):
        key       = f'{year}-{m:02d}'
        month_txs = by_month.get(key, [])
        if m == num_months and partial_to is not None:
            month_txs = [tx for tx in month_txs
                         if tx_date(tx) is not None and tx_date(tx) <= partial_to]
        running += sum_amount_base(month_txs, rate_map, quote_currency)
        result.append(round(running, 2))
    return result


def sample_month_end_assets(asset_accounts, all_txs, year_start, a_end, num_months, is_current_year, rate_map, quote_currency):
    """Sample end-of-month total assets for num_months months starting at year_start.

    Mirrors _sampleMonthEndAssets() in 05-ytd-comparison.js.
    """
    daily = compute_daily_total_assets(asset_accounts, all_txs, year_start, a_end, rate_map, quote_currency)
    result = []
    year   = year_start.year
    for m in range(num_months):
        is_last = m == num_months - 1
        if is_last and is_current_year:
            sample = a_end
        else:
            _, last_day = calendar.monthrange(year, m + 1)
            sample = date(year, m + 1, last_day)
        idx = (sample - year_start).days
        result.append(round(daily[min(idx, len(daily) - 1)] if daily else 0.0, 2))
    return result


def last_non_null(arr):
    for v in reversed(arr):
        if v is not None:
            return v
    return 0.0


def tx_amount_base(tx, rate_map, quote_currency):
    """Convert a single transaction's amount to base currency."""
    return to_base(
        tx.get(TxField.AMOUNT),
        tx.get(TxField.CURRENCY),
        tx.get(TxField.FX_RATE),
        rate_map,
        quote_currency,
    )


def split_tags(tx):
    """Return a list of normalised (lowercase, stripped) non-empty tags for a tx."""
    raw = tx.get(TxField.TAGS, '') or ''
    return [t.strip().lower() for t in raw.split(';') if t.strip()]


def aggregate_tags(money_out_txs, rate_map, quote_currency):
    """Proportional spend per tag.

    Each tag on a tx receives amount_base / num_tags.
    Returns sorted list of {'label': tag, 'amount': total, 'count': tx_count}.
    """
    totals = defaultdict(float)
    counts = defaultdict(int)
    for tx in money_out_txs:
        tags = split_tags(tx)
        if not tags:
            continue
        share = tx_amount_base(tx, rate_map, quote_currency) / len(tags)
        for tag in tags:
            totals[tag] += share
            counts[tag]  += 1
    return sorted(
        [{'label': t, 'amount': round(totals[t], 2), 'count': counts[t]} for t in totals],
        key=lambda x: x['amount'],
        reverse=True,
    )


def group_by_major(txs):
    """Group txs by major_category; falls back to 'Uncategorised'."""
    groups = defaultdict(list)
    for tx in txs:
        key = tx.get(TxField.MAJOR_CATEGORY) or 'Uncategorised'
        groups[key].append(tx)
    return dict(groups)
