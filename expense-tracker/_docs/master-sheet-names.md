# Master CSV, Sheet and database names

The four masters use the same singular name for their Sheet tabs, ledger-extract entity keys and database tables:

| Local CSV in `local/files/` | Sheet tab | PostgreSQL table | Previous Sheet tab |
|---|---|---|---|
| `account_master.csv` | `account_master` | `account_master` | `accounts` |
| `category_master.csv` | `category_master` | `category_master` | `categories` |
| `transaction_master_YYYY_MM.csv` (monthly files) | `transaction_master` | `transaction_master` | `transactions` |
| `subscription_master.csv` | `subscription_master` | `subscription_master` | `subscriptions` |

The CSV renames preserve their contents byte-for-byte. Columns, UUIDs, financial values and sync/audit fields are unchanged. PostgreSQL already uses these names, so this change requires no database migration. The earlier extension-table migration `0018` remains a separate prerequisite for the current extractor.

## Upgrade an existing spreadsheet

1. Deploy the updated expense-tracker GAS backend to the environment being upgraded and publish the corresponding frontend changes.
2. In that spreadsheet's bound Apps Script editor, run `migrateMasterSheetNames()` from [master-migration.gs](../api/master-migration.gs).
3. Confirm `ok: true`. The helper renames existing legacy tabs in place; the tab IDs, headers, rows, UUIDs and sync metadata remain intact. Canonical tabs are left unchanged, absent tabs are not created, and rerunning the helper is safe.
4. Run ledger-extract with the updated `config.yaml`, whose master keys are `category_master`, `account_master`, `transaction_master` and `subscription_master`. The supplied configuration enables transaction extraction; prepare all enabled tabs or explicitly disable those outside the intended scope. Normal-sync is sufficient for the name change; hard-sync remains available for intentional reprocessing.

The helper takes a script lock and preflights all four masters before renaming anything. If both old and new names exist, it returns `master_sheet_name_collision`; reconcile the duplicate tabs explicitly before retrying. A mismatched existing header layout returns `sheet_header_mismatch`. It does not merge or delete either tab. If a rename service call fails after earlier names changed, the response identifies completed renames; retrying can finish the remaining names. If the account, category and subscription tabs were migrated previously, rerun the updated helper to rename only the remaining `transactions` tab.

Normal app access detects legacy names and returns `legacy_master_sheet_name` instead of silently creating an empty replacement. Collision errors also block normal access. Ledger-extract reads and acknowledges only the canonical tab names; a missing enabled master tab points to this migration helper and fails before entity writes. If both old and new tabs exist for an enabled master, extraction stops with `master_sheet_name_collision:<tab>` before reading values or writing records. Disabled masters remain outside the extraction scope. Python never renames live Sheet tabs.

For a fresh spreadsheet, normal entity access uses canonical tabs with the current schemas. Import the `account_types` catalog explicitly before creating accounts or using category hints; it has no automatic seed. Create/import each enabled entity before extraction. The account importer uses `file_type=account_master`; category and subscription imports continue through their existing bulk APIs. Frontend exports use `account_master`, `category_master` and `subscription_master` filename prefixes with the existing date suffix. UI section labels, API actions such as `list_accounts`, and response keys remain unchanged.

This code update does not deploy the app or rename live tabs automatically. Local CSV renames are already applied.

After renaming, use **Expense Tracker → Arrange sheet tabs** or reopen the spreadsheet to apply the [configured tab order](sheet-order.md).
