import calendar
from datetime import date, timedelta


def resolve_period(period_key, today=None):
    """Return (from_date, to_date) for a period_key.

    Mirrors getPeriodBounds() in insight-utils.js.
    Returns (None, None) for 'default' — caller interprets as full data range.
    to_date may be in the future for current-period keys (this_month, last_3, etc.);
    compute functions cap at today as needed.
    """
    today = today or date.today()

    if period_key == 'default':
        return None, None

    if period_key == 'this_week':
        # Mon of current week (Python weekday: 0=Mon)
        from_date = today - timedelta(days=today.weekday())
        to_date   = from_date + timedelta(days=6)

    elif period_key == 'last_week':
        this_mon  = today - timedelta(days=today.weekday())
        from_date = this_mon - timedelta(days=7)
        to_date   = this_mon - timedelta(days=1)

    elif period_key == 'last_7':
        from_date = today - timedelta(days=7)
        to_date   = today

    elif period_key == 'last_30':
        from_date = today - timedelta(days=30)
        to_date   = today

    elif period_key == 'last_60':
        from_date = today - timedelta(days=60)
        to_date   = today

    elif period_key == 'last_90':
        from_date = today - timedelta(days=90)
        to_date   = today

    elif period_key == 'this_month':
        from_date = today.replace(day=1)
        _, last   = calendar.monthrange(today.year, today.month)
        to_date   = today.replace(day=last)

    elif period_key == 'last_month':
        first_this = today.replace(day=1)
        last_prev  = first_this - timedelta(days=1)
        from_date  = last_prev.replace(day=1)
        to_date    = last_prev

    elif period_key == 'last_3':
        # JS: new Date(year, month-2, 1)  (0-indexed month)
        m, y = today.month - 2, today.year
        if m <= 0: m += 12; y -= 1
        from_date     = date(y, m, 1)
        _, last       = calendar.monthrange(today.year, today.month)
        to_date       = today.replace(day=last)

    elif period_key == 'last_6':
        m, y = today.month - 5, today.year
        if m <= 0: m += 12; y -= 1
        from_date     = date(y, m, 1)
        _, last       = calendar.monthrange(today.year, today.month)
        to_date       = today.replace(day=last)

    elif period_key == 'last_12':
        m, y = today.month - 11, today.year
        if m <= 0: m += 12; y -= 1
        from_date     = date(y, m, 1)
        _, last       = calendar.monthrange(today.year, today.month)
        to_date       = today.replace(day=last)

    elif period_key == 'this_quarter':
        q         = (today.month - 1) // 3          # 0-indexed quarter
        from_date = date(today.year, q * 3 + 1, 1)
        end_month = q * 3 + 3
        _, last   = calendar.monthrange(today.year, end_month)
        to_date   = date(today.year, end_month, last)

    elif period_key == 'last_quarter':
        q  = (today.month - 1) // 3
        pq = 3 if q == 0 else q - 1
        yr = today.year - 1 if q == 0 else today.year
        from_date  = date(yr, pq * 3 + 1, 1)
        end_month  = pq * 3 + 3
        _, last    = calendar.monthrange(yr, end_month)
        to_date    = date(yr, end_month, last)

    elif period_key == 'ytd':
        from_date = date(today.year, 1, 1)
        to_date   = today

    elif period_key == 'last_year':
        from_date = date(today.year - 1, 1, 1)
        to_date   = date(today.year - 1, 12, 31)

    else:
        raise ValueError(f'Unknown period_key: {period_key!r}')

    return from_date, to_date
