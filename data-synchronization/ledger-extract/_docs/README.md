# Sheet → database mappings

These are current mapping documents, checked against the expense-tracker GAS schemas/import registry and the ledger-extract transform, writer and migration code. They replace the former task plans. They describe the local code contract, not an inspection of a live Google Sheet or deployed database.

Currency-rate synchronization belongs exclusively to the [currency-rates module](../../currency-rates/README.md). Ledger-extract only reads its database rates for monetary conversions; rates are outside this Sheet-to-database mapping scope.

## Entity documents

| Document | Source tab(s) | Source columns | Main database table(s) / columns | Coverage |
|---|---|---:|---|---|
| [Accounts](accounts.md) | `accounts` | 19 | `account_master` — 19 | Every source field, derived amount/rate fields, source versus DB audit timestamps |
| [Categories](categories.md) | `categories` | 21 | `category_master` — 16, plus two 2-column junctions | Every source field, account-type expansion and complete reference-table columns |
| [Transactions](transactions.md) | `transactions` | 24 | `transaction_master` — 28 | Every source field, generated IDs, currency/time conversions, counterparty and beneficiary tables |
| [Subscriptions](subscriptions.md) | `subscriptions` | 21 | `subscription_master` — 17 | Every source field, account/category/counterparty resolution and timestamp semantics |
| [Account details](account-details.md) | Six current detail tabs | 72 | Seven legacy extension tables — 123 columns | Complete source/target inventory; extraction **not implemented**; candidates clearly separated from actual mappings |
| [Structure and operational mapping](SETUP.md) | Spreadsheet metadata, no entity tab | — | `job_execution_details`, unused `ledger_data_checksums` | Every operational column and its actual origin/use |
| [Mapping notes and open decisions](implementation-learning.md) | Shared conventions | — | Cross-entity | Identity, money, dates, omissions and unresolved source/DB differences |

The four extracted master tabs contain **85 source columns**. Database rows may contain additional generated or derived columns, but not every source column is persisted: sync metadata stays in the Sheet, source audit timestamps are currently omitted, lists can expand into junction rows, and category/account/counterparty values can become foreign keys. Consequently, a main DB table need not have more columns than its source tab even when the overall relational model contains more fields.

## How to read the mappings

Each entity document lists source columns in Sheet order with their destination and transformation. Database-only or related-table sections account for columns not directly copied from the source. “Not persisted” means exactly that; it does not imply the job stores the field elsewhere. “Candidate” in account details describes a possible correspondence, **not implemented extraction**.

Database inventories reflect the complete migration chain through 0013, including `tracking_start_date_local`, `applied_rate_value` and nullable subscription start dates. They do not treat stale generated models as the schema. The ledger migration chain defines **19 tables and 243 columns**, including legacy reserved tables; currency tables are separate dependencies owned by currency-rates.

## Primary source references

- GAS registries: [accounts](../../../expense-tracker/api/account-schema.gs), [categories](../../../expense-tracker/api/category-schema.gs), [transactions](../../../expense-tracker/api/transaction-schema.gs), [subscriptions](../../../expense-tracker/api/subscription-schema.gs).
- Detail tabs: [import registry](../../../expense-tracker/api/import-registry.gs), [import validation/writer](../../../expense-tracker/api/import-core.gs), [account import guide](../../../expense-tracker/_docs/account-imports.md).
- Extractor: [Sheet contracts](../sheets/contracts.py), [transforms](../transforms), [database writers](../database), [migrations](../migrations).
- Execution and recovery: [module README](../README.md), [usage](../_runbooks/USAGE-INSTRUCTIONS.md).

## Known documentation/schema traps

`database/models/` contains obsolete generated definitions and incomplete coverage. For example, old account-type/category fields do not match the current migration definitions. Runtime entity writers do not use these models. Do not implement mappings from those files without regenerating and checking them.

The current `py_db_schema.toml` supplies ledger migrations only, while ledger foreign keys require the currency schema first. A fresh model-generation database therefore needs those prerequisite migrations arranged before `make generate-models` can be relied on. This documentation change neither regenerates models nor changes the database schema.
