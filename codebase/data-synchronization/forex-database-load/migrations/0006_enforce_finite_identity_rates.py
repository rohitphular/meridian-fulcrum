from typing import Any


def upgrade(client: Any) -> None:
    """Enforce the rate invariants even for writes outside this Python job."""
    with client.cursor() as cursor:
        # PostgreSQL NUMERIC NaN compares greater than ordinary values, so the
        # original positive CHECK alone does not reject it. Existing bad rows
        # deliberately fail validation; do not rewrite financial history here.
        cursor.execute("ALTER TABLE currency_rates ADD CONSTRAINT chk_cr_rate_finite CHECK (rate_value NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric))")
        cursor.execute("ALTER TABLE currency_rates ADD CONSTRAINT chk_cr_xau_identity CHECK (quote_currency_code != 'XAU' OR rate_value = 1)")
    client.commit()
