from __future__ import annotations

import sys
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path

from py_db_migrate.adapters.postgres import get_client
from py_logging import get_logger

import core.config as config
import sources.crypto as crypto
import sources.fiat as fiat
from core.errors import failure_reason
from core.fetcher import require_rates, store_identity_rates, store_rates
from database.currency_master import get_currencies
from database.locking import claim_job
from database.upsert import forward_fill_rates

logger = get_logger(__name__)


def main() -> None:
    client = None
    try:
        csv_dir = Path(config.historical_csv_dir())
        to_date = datetime.now(timezone.utc).date()
        logger.info(f"historical: to_date={to_date}")
        client = get_client(config.db_config())
        claim_job(client)
        fiat_rates: dict[str, dict[date, Decimal]] = {}
        for code in get_currencies(client, "fiat"):
            symbol = fiat.SYMBOLS.get(code, f"xau{code.lower()}")
            file_path = csv_dir / f"{symbol}.csv"
            if not file_path.exists():
                logger.warning(f"historical: currency={code} reason=file_missing")
                continue
            rate_data = fiat.load_file(file_path, code)
            if not rate_data or max(rate_data) > to_date:
                raise ValueError("empty_invalid_or_future_dated_csv")
            fiat_rates[code] = rate_data

        if not fiat_rates:
            raise ValueError("no_fiat_data_loaded")
        from_date = min(rate_date for date_rates in fiat_rates.values() for rate_date in date_rates)
        crypto_rates = {}
        if config.source_enabled("yfinance"):
            crypto_codes = get_currencies(client, "crypto")
            crypto_rates = crypto.fetch_range(crypto_codes, from_date, to_date)
            require_rates(crypto_codes, crypto_rates)

        store_rates(client, fiat_rates, "stooq")
        store_rates(client, crypto_rates, "yfinance")
        store_identity_rates(client, from_date, to_date)
        forward_fill_rates(client, from_date, to_date, list(fiat_rates))
        client.commit()
        logger.info(f"historical: complete=true fiat_currencies={len(fiat_rates)} crypto_currencies={len(crypto_rates)} from={from_date} to={to_date}")
    except Exception as error:
        if client is not None:
            client.rollback()
        logger.error(f"historical: job_failed=true error={type(error).__name__} reason={failure_reason(error)}")
        sys.exit(1)
    finally:
        if client is not None:
            client.close()


if __name__ == "__main__":
    main()
