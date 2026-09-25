# Legacy precomputed-insights job

This Python processor is **not compatible with the current expense-tracker data model**. The app's live Insights screen remains available.

The job calculations expect the historical dual-leg contract: `tx_date_time`, `amount`, transaction currency, `source_account`/`target_account`, and account `is_active`/`opening_value`. Current Sheets use `transaction_master`, one account movement per row, account-local currency, lifecycle status and tracking-aware balance snapshots. Renaming tabs alone cannot make those calculations correct.

`make job-start` with Insights selected (including the default full run) now exits with `unsupported_insights_source_contract` before loading service-account credentials or opening Sheets. The runner compares the current `single-leg-master-v1` declaration against the job's explicit `legacy-dual-leg-v1` requirement. Direct calls to `InsightsJob.run()` perform the same check. This guard should remain until every calculation is ported and validated; changing the version label is not a migration.

For a deliberately supplied legacy contract, every required source header is checked before financial rows are read. Missing source tabs fail instead of becoming empty data. Any calculation failure prevents replacement of `computed_insights`, preserving previously published results. These checks do not certify the legacy calculations for current financial data.

Before enabling this processor for current Sheets, implement and test single-leg transfer handling, `record_status`, account tracking boundaries, account currency resolution, exact monetary arithmetic, and the output contract consumed by the frontend. The KPI summary job is still a placeholder.

Offline guard tests can use the ledger module's existing Python test environment from the repository root:

```bash
uv run --project data-synchronization/ledger-extract --locked python -m pytest expense-tracker/job/tests/unit
```

No live Sheet data or credentials are needed by these tests.
