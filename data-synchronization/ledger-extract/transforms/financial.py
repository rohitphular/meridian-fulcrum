from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal, localcontext

_BIGINT_MIN = -(2**63)
_BIGINT_MAX = 2**63 - 1


def to_minor_units(amount: Decimal, decimal_places: int, field: str = "amount") -> int:
    """Round signed major units once, rejecting values PostgreSQL BIGINT cannot store."""
    if not isinstance(amount, Decimal) or not amount.is_finite():
        raise ValueError(f"{field}: invalid_decimal")
    if isinstance(decimal_places, bool) or not isinstance(decimal_places, int) or not 0 <= decimal_places <= 18:
        raise ValueError(f"{field}: invalid_decimal_places")
    # Bound the exponent before arithmetic or conversion to a potentially enormous int.
    if amount and amount.adjusted() + decimal_places > 19:
        raise ValueError(f"{field}: bigint_overflow")
    if amount and amount.adjusted() + decimal_places < -1:
        return 0
    with localcontext() as context:
        context.prec = max(64, len(amount.as_tuple().digits) + decimal_places + 4)
        rounded = amount.scaleb(decimal_places).to_integral_value(rounding=ROUND_HALF_UP)
    if not _BIGINT_MIN <= rounded <= _BIGINT_MAX:
        raise ValueError(f"{field}: bigint_overflow")
    return int(rounded)
