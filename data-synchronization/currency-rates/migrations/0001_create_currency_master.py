def upgrade(client) -> None:
    with client.cursor() as cursor:
        cursor.execute("""
            CREATE OR REPLACE FUNCTION fn_set_updated_at()
            RETURNS TRIGGER LANGUAGE plpgsql AS $$
            BEGIN
              NEW.updated_at = NOW();
              RETURN NEW;
            END;
            $$;
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS currency_master (
              currency_code     CHAR(3)      NOT NULL,
              currency_name     TEXT         NOT NULL,
              currency_symbol   TEXT         NOT NULL,
              decimal_places    SMALLINT     NOT NULL DEFAULT 2,
              currency_type     TEXT         NOT NULL,
              is_tracked        BOOLEAN      NOT NULL DEFAULT TRUE,
              currency_rank     INTEGER      NULL,
              data_last_fetched DATE         NULL,
              created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
              updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

              CONSTRAINT currency_master_pkey     PRIMARY KEY (currency_code),
              CONSTRAINT chk_cm_code_length       CHECK (char_length(currency_code) = 3),
              CONSTRAINT chk_cm_currency_type     CHECK (currency_type IN ('fiat', 'commodity', 'crypto')),
              CONSTRAINT chk_cm_decimal_places    CHECK (decimal_places BETWEEN 0 AND 8),
              CONSTRAINT chk_cm_rank_positive     CHECK (currency_rank > 0)
            );
        """)
        cursor.execute("""
            CREATE TRIGGER trg_currency_master_updated_at
              BEFORE UPDATE ON currency_master
              FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
        """)
        cursor.execute("""
            INSERT INTO currency_master (currency_code, currency_name, currency_symbol, decimal_places, currency_type, is_tracked, currency_rank) VALUES
              ('XAU', 'Gold (per gram)',      'XAU',  2, 'commodity', TRUE,  NULL),
              ('USD', 'US Dollar',            '$',    2, 'fiat',      TRUE,  1),
              ('EUR', 'Euro',                 '€',    2, 'fiat',      TRUE,  2),
              ('GBP', 'Pound Sterling',       '£',    2, 'fiat',      TRUE,  3),
              ('INR', 'Indian Rupee',         '₹',    2, 'fiat',      TRUE,  4),
              ('JPY', 'Japanese Yen',         '¥',    0, 'fiat',      TRUE,  5),
              ('CNY', 'Chinese Yuan',         'CN¥',  2, 'fiat',      TRUE,  6),
              ('AUD', 'Australian Dollar',    'A$',   2, 'fiat',      TRUE,  7),
              ('CAD', 'Canadian Dollar',      'C$',   2, 'fiat',      TRUE,  8),
              ('CHF', 'Swiss Franc',          'CHF',  2, 'fiat',      TRUE,  9),
              ('SGD', 'Singapore Dollar',     'S$',   2, 'fiat',      TRUE,  10),
              ('AED', 'UAE Dirham',           'AED',  2, 'fiat',      TRUE,  11),
              ('HKD', 'Hong Kong Dollar',     'HK$',  2, 'fiat',      TRUE,  12),
              ('BRL', 'Brazilian Real',       'R$',   2, 'fiat',      TRUE,  13),
              ('KRW', 'South Korean Won',     '₩',    0, 'fiat',      TRUE,  14),
              ('BTC', 'Bitcoin',              '₿',    8, 'crypto',    TRUE,  15),
              ('ETH', 'Ethereum',             'Ξ',    6, 'crypto',    TRUE,  16),
              ('SOL', 'Solana',               'SOL',  6, 'crypto',    TRUE,  17)
            ON CONFLICT (currency_code) DO NOTHING;
        """)
    client.commit()
