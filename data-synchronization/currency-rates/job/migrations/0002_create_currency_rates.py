def upgrade(client) -> None:
    with client.cursor() as cursor:
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS currency_rates (
              rate_id            UUID          NOT NULL DEFAULT gen_random_uuid(),
              currency_code      CHAR(3)       NOT NULL,
              rate_date          DATE          NOT NULL,
              rate_value         NUMERIC(19,6) NOT NULL,
              base_currency_code CHAR(3)       NOT NULL DEFAULT 'XAU',
              rate_source        TEXT          NOT NULL,
              created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
              updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

              CONSTRAINT currency_rates_pkey      PRIMARY KEY (rate_id),
              CONSTRAINT uq_cr_currency_date      UNIQUE (currency_code, rate_date),
              CONSTRAINT fk_cr_currency_code      FOREIGN KEY (currency_code)      REFERENCES currency_master (currency_code),
              CONSTRAINT fk_cr_base_currency_code FOREIGN KEY (base_currency_code) REFERENCES currency_master (currency_code),
              CONSTRAINT chk_cr_rate_positive     CHECK (rate_value > 0),
              CONSTRAINT chk_cr_base_is_xau       CHECK (base_currency_code = 'XAU')
            );
        """)
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_cr_currency_date ON currency_rates (currency_code, rate_date DESC);")
        cursor.execute("""
            CREATE TRIGGER trg_currency_rates_updated_at
              BEFORE UPDATE ON currency_rates
              FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
        """)
        cursor.execute("""
            CREATE VIEW v_latest_rates AS
            SELECT DISTINCT ON (currency_code)
              currency_code, rate_value, rate_date, base_currency_code, rate_source
            FROM currency_rates
            ORDER BY currency_code, rate_date DESC;
        """)
        cursor.execute("""
            CREATE VIEW v_rates_to_gbp AS
            SELECT
              r.currency_code,
              r.rate_date,
              r.rate_value                  AS rate_vs_xau,
              gbp.rate_value                AS gbp_vs_xau,
              gbp.rate_value / r.rate_value AS rate_to_gbp
            FROM v_latest_rates r
            JOIN v_latest_rates gbp ON gbp.currency_code = 'GBP';
        """)
    client.commit()
