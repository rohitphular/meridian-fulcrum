# Account and extension ETL review — 24 September 2026

The initial seven-family review below is historical. The final six-table contract supersedes its extension scope; see [current mappings](../_docs/account-details.md).

Reviewed the current expense-tracker account schema/import registry, all eight extension sources, their seven database families, migrations, validation, write ordering and sync acknowledgements. This was a local code review with fixtures and disposable PostgreSQL; no live Sheet, configured database or deployment was changed.

## Confirmed gaps closed

| Gap | Result |
|---|---|
| Account source UUID matching was case-sensitive; single creates accepted duplicate/malformed IDs | Validate supplied UUIDs and match canonically. Existing UUID spelling remains intact for source references; extraction retains the same canonical UUID. |
| Omitted lifecycle status during master import could reactivate an existing account | Preserve its current lifecycle state, including repeated replacements in one batch. New IDs default to active. |
| Direct master edits could remain `in-sync`; lifecycle changes retained old sync dates | Business/lifecycle edits, including the appended tracking date, queue sync and clear stale acknowledgement fields. Source creation timestamps remain untouched. |
| Source amount/date validation allowed values that extraction rejected; JavaScript conversion lost decimal precision | Preserve decimal text through the account form/import/backend, validate full ASCII decimal syntax, and reject invalid local calendar dates or closing-before-opening. |
| Negative asset/investment opening snapshots were source-valid but rejected by ETL/database | Migration `0017` permits their original signs in local/base amounts; liability values remain nonpositive. Existing stored values and UUIDs are unchanged. |
| Master writes committed before checking for concurrent source edits | Recheck captured source content before each account commit. A guard failure rolls back the current row and produces no stale row acknowledgement. |
| The new per-account guard exhausted Sheets read quota by rereading metadata, headers and pages separately for every tab | One whole-tab batch read per guard, paced reads/writes and bounded 429 backoff. Acknowledgements use one batch write with a fresh source check before every retry attempt. |
| Detail owner/property subtype validation could race with a database master update | Hold shared locks on referenced master rows until the detail tab commits; master subtype updates use an update lock and validate retained details. |
| A source-check `ValueError` could be reported as a detail row failure | Preserve the source-check exception, roll back the tab and avoid stale failure acknowledgements. |
| Detail reassignment could leave a source row that the DB refuses to move | Source import rejects moving an existing detail UUID to another account before target migration/writes; the database also retains its association guard. |
| Unexpected stored detail provenance could raise a raw lookup failure | Return a safe reconciliation error for unknown or wrong-family source provenance. |
| Fixed-income/P2P errors disappeared into a generic runner message | Report validated tab/physical-row/error codes while redacting unstructured values and raw database errors. |

## Verification

The required ledger checks passed: `make lint`, **345 unit tests** and **91 PostgreSQL integration tests**, with no skips. Integration fixtures now share a temporary PostgreSQL cluster with private Unix sockets, no TCP listener and a separate database per test.

The account pipeline tests exercise all eight extension sources together: initial load, normal-sync skip, hard-sync revaluation, missing account/detail recovery, and replay after failed Sheet acknowledgement. Additional tests cover signed monetary rounding, reference locks, late base-value overflow rollback, invalid corrected rates, lifecycle replay and source-check failures. All **63 expense-tracker tests** passed, covering UUIDs, lifecycle preservation, decimal transport, date validation, direct-edit queues and invalid reassignment without target writes.

After the reported quota failure, ledger lint/format checks, **370 unit tests** and **92 PostgreSQL integration tests** passed. The added full-pipeline regression processes 23 accounts and all eight detail sources in normal and hard sync using 33 value-batch reads (capture, 23 account guards, eight detail guards, acknowledgement guard), one tab-metadata read and one acknowledgement write per run; production initialization adds one metadata read. Unit checks cover minute-quota recovery, retry exhaustion, source edits during write backoff, reordered headers, sparse rows and appended rows/columns. Live dev/prod data was not changed by these checks.

## Applying the changes

Deploy the expense-tracker backend and updated frontend. Normal ledger startup applies migration `0017`; pending/failed records retry with their original UUIDs. Existing property tabs still require the previously documented column migration followed by one hard-sync. Enable accounts and the desired detail tabs explicitly; checked-in entity toggles were not changed by this review.

See [usage and recovery](USAGE-INSTRUCTIONS.md), [account master mapping](../_docs/account-master.md), [extension mappings](../_docs/account-details.md), and [source import upgrades](../../../expense-tracker/_docs/account-imports.md).

The remaining integration boundaries are explicit: Sheets and PostgreSQL have no shared transaction or atomic conditional acknowledgement, so avoid concurrent Sheet edits during extraction. Physical source removal is not a deletion instruction. Extension rows preserve supplied snapshots; they do not reconstruct transaction-driven balances or omitted legacy history. Live deployment and real Sheet formatting/permissions still need an operational run.


## Final extension scope and table names

Migration `0018_align_account_detail_tables.py` gives every supported extension the exact Sheet name: `account_deposit`, `account_liability_credit_card`, `account_liability_mortgage`, `account_liability_personal_loan`, `account_investment_property`, and `account_investment_stocks`. The two loan tables now have independent primary-key namespaces and separate mapping documents.

Supported rows retain all columns, UUIDs, audit timestamps and legacy history. Source provenance must agree with the owning loan subtype; legacy rows without provenance must belong to mortgage or personal-loan accounts. Ambiguous rows abort the transaction. Foreign keys, constraints and indexes are preserved; unknown dependencies prevent destructive drops without cascading. The old fixed-income/P2P detail tables and contents are dropped as requested; active import/extractor code, config and mapping docs for those two extensions are removed. Account-master subtype support remains. Prior migration definitions remain only as applied-schema history for upgrades.

Validation covers upgrade from migration 0017 with populated supported and retired tables, complete row preservation, separate loan foreign keys/provenance, rejection and rollback for ambiguous loan rows, and rollback when an external view depends on a table being removed. No configured dev/prod database or live Sheet was changed.

Final validation: ledger lint/format checks, **357 unit tests**, **88 disposable PostgreSQL integration tests**, **63 expense-tracker tests**, and `git diff --check` passed.
