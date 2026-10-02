# Sheet → database mappings

These are current mapping documents, checked against the expense-tracker GAS schemas/import registry and the ledger-sheet-extract transform, writer and migration code. They replace the former task plans. They describe the local code contract, not an inspection of a live Google Sheet or deployed database.

Currency-rate synchronization belongs exclusively to the [currency-database-load module](../../currency-database-load/README.md). Ledger-extract only reads its database rates for monetary conversions; rates are outside this Sheet-to-database mapping scope.

## Entity documents

| Document | Source tab(s) | Source columns | Main database table(s) / columns | Coverage |
|---|---|---:|---|---|
| [Account types](account-types.md) | `account_types` | 13 | `account_types` — 14 | Configuration, source UUID ownership, one-time existing-catalog adoption, source policy and lifecycle/sync metadata |
| [Account master](account-master.md) | `account_master` | 19 | `account_master` — 19 | Every source field, derived amount/rate fields, source versus DB audit timestamps |
| [Category master](category-master.md) | `category_master` | 21 | `category_master` — 16, plus two 2-column junctions | Every source field, account-type expansion and complete reference-table columns |
| [Transactions](transaction-master.md) | `transaction_master` | 24 | `transaction_master` — 28 | Every source field, generated IDs, currency/time conversions, counterparty and beneficiary tables |
| [Subscriptions](subscription-master.md) | `subscription_master` | 21 | `subscription_master` — 20 | Every source field, account/category/counterparty resolution and timestamp semantics |
| [Account details](account-details.md) | Six detail tabs | 106 | Six tables named after their Sheet tabs | One document per detail type maps all source, derived and retained legacy fields |
| [Structure and operational mapping](SETUP.md) | Spreadsheet metadata, no entity tab | — | None (migration `0023` dropped the former job tables) | Data flow and the absence of operational tables |
| [Mapping notes and open decisions](implementation-learning.md) | Shared conventions | — | Cross-entity | Identity, money, dates, omissions and unresolved source/DB differences |

The four master tabs contain **85 source columns**, account-type configuration adds **13**, and six detail tabs add **106**, for **204** total source columns when all are enabled. Database rows may contain additional generated or derived columns, but not every source column is persisted: sync metadata stays in the Sheet except for the account-types ingestion state, source audit timestamps are currently omitted, lists can expand into junction rows, and category/account/counterparty values can become foreign keys. Consequently, a main DB table need not have more columns than its source tab even when the overall relational model contains more fields.

## How to read the mappings

Each entity document lists source columns in Sheet order with their destination and transformation. Database-only or related-table sections account for columns not directly copied from the source. “Not persisted” means exactly that; it does not imply the job stores the field elsewhere. For detail rows, retained legacy columns without a source remain NULL; the family documents identify each one.

Database inventories reflect the complete migration chain through 0023 (which drops the unused job tracking tables), including `tracking_start_date_local`, `applied_rate_value`, nullable subscription start dates and account type/subtype keys and labels. They do not treat stale generated models as the schema. The ledger migration chain defines **18 tables**, including reserved tables; currency tables are separate dependencies owned by currency-database-load.

## Primary source references

- GAS registries: [accounts](../../../expense-tracker/api/account-schema.gs), [categories](../../../expense-tracker/api/category-schema.gs), [transactions](../../../expense-tracker/api/transaction-schema.gs), [subscriptions](../../../expense-tracker/api/subscription-schema.gs).
- Detail tabs: [import registry](../../../expense-tracker/api/import-registry.gs), [import validation/writer](../../../expense-tracker/api/import-core.gs), [account import guide](../../../expense-tracker/_docs/account-imports.md).
- Extractor: [Sheet contracts](../sheets/contracts.py), [transforms](../transforms), [database writers](../database), [migrations](../migrations).
- Execution and recovery: [module README](../README.md), [usage](../_runbooks/USAGE-INSTRUCTIONS.md).

## Known documentation/schema traps

`database/models/` contains obsolete generated definitions and incomplete coverage. The account-types model reflects migrations through 0022, but the old category model still differs from the current migration definitions. Runtime entity writers do not use these models. Check generation status before using other model files for mappings.

The current `py_db_schema.toml` supplies ledger migrations only, while ledger foreign keys require the currency schema first. A fresh model-generation database therefore needs those prerequisite migrations arranged before `make generate-models` can be relied on. Migrations 0015–0018 change the detail schema; the new mappings use its executed schema and writer contract. The legacy generated models are not used for detail extraction.
