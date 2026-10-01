# Configure — Account Types

Configure → Account Types manages existing account classifications in a collapsible panel. It uses the same toolbar, filters, forms, status icons, row menus and mobile cards as the other modules. The CSV, Sheet tab and database table are named `account_types`. Classification keys use lower-case hyphenated values, such as `stocks-shares`; column names and Sheet names keep their existing underscores.

## Source catalog and identity

The Sheet supplies classification keys, labels and detail-import eligibility. There is no application seed, fixed family catalog, hardcoded subtype count or embedded subtype mapping. An absent or empty Sheet lists no rows and creates nothing on GET. Import the supplied complete `local/files/account_types.csv` to bootstrap it.

After the Sheet is populated, neither the API nor CSV import can add an ID/classification. Existing UUIDs, family keys and subtype keys are immutable. View, edit descriptive/policy fields, soft-delete and restore existing rows. The explicit legacy migration accepts only the equivalent underscore-to-hyphen key conversion. Source UUIDs and creation timestamps survive imports and migrations.

Family labels must agree across every row in the family, including retired rows. Editing a family label propagates it to its siblings and queues each affected row. A locked sibling prevents that edit. CSV imports validate family labels against the complete resulting catalog before writing.

## Sheet and CSV contract

| Position | Column | Meaning |
|---|---|---|
| 1 | `id` | Required source UUID; never generated or reassigned. |
| 2 | `account_type_key` | Existing family key; lowercase hyphen-separated tokens. |
| 3 | `account_type_label` | Editable Sheet-supplied family label; consistent across siblings. |
| 4 | `account_subtype_key` | Existing globally unique subtype key; lowercase hyphen-separated tokens. Existing family keys are reserved. |
| 5 | `account_subtype_label` | Editable display label. |
| 6 | `description` | Optional description. |
| 7 | `detail_sheet` | Blank or one of the six supported detail Sheet names exposed by the import registry. Controls detail-import eligibility. |
| 8 | `record_status` | `active`, `inactive`, `deleted` or `locked`. |
| 9 | `sync_status` | Server-owned pending/success/failure status. |
| 10 | `sync_date` | Cleared on a source mutation; extractor acknowledgement timestamp. |
| 11 | `sync_notes` | Cleared on a source mutation; safe extractor outcome. |
| 12 | `created_at` | Source creation timestamp; preserved on replacement and upgrade. |
| 13 | `updated_at` | Refreshed on source mutation/direct business edit. |

The former `is_loan` column (between `description` and `detail_sheet`) was retired on 2026-09-29. A Sheet that still has it fails with `account_types_is_loan_column_present`: delete that column in the Sheet before using the updated app or extractor. Exports made before the change have 14 columns and no longer import.

The final six columns retain the shared lifecycle/sync/audit order. Import/export use all 13 columns. Configure → Export always downloads the complete, unfiltered catalog (every status, existing UUIDs) as `account_types-YYYY-MM-DD.csv`, which Import accepts unchanged as a restore file. Imported sync/audit values cannot mark a mutation as synchronized: the backend owns those values. All candidates, identities, policies and required dependent references are checked before any write. Invalid batches have no partial row success.

## CSV import

Configure → Account Types → Import uploads the chosen file's raw text (`{ csv }`) to `create_account_types_bulk`. The browser does not parse, preview or validate the file; the server (`importAccountTypesCsv` in `api/account-type-import.gs`) does all of it and the panel shows the outcome.

1. **File checks.** The file must parse as CSV and contain a header plus at least one record. The headers must be exactly the 13 `account_types` columns, in any order. A 14-column export that still has `is_loan` is rejected.
2. **Row checks.** Each row needs a valid UUID, which is stored lower-case. Type and subtype keys must be lower-case and hyphenated, and both labels must be non-empty. `detail_sheet` must be blank or a supported detail Sheet. `record_status` must be one of `active`, `inactive`, `deleted` or `locked`; a blank status is rejected.
3. **Whole-file checks.** UUIDs and subtype keys must be unique. Every row in a family must use the same family label, and no subtype key may equal a type key.
4. **Catalog checks** (real run only). Once the Sheet is populated, only existing UUIDs are accepted (`account_type_creation_restricted`). Classification keys cannot change (`field_not_editable`, with `field`); legacy underscore keys compare after `_` → `-`. A legacy upgrade must include every existing UUID (`complete_account_type_catalog_required`). Locked, in-use and detail-mapping rules then apply as for edits.

Failures in steps 1–3 return `invalid_csv_rows` (or the CSV parse code) with `errors: ['Row <line>: …']`, where the line is the physical line in the file. Nothing is written. A step 4 failure rejects the whole batch with its error code. Success returns `created`, `updated`, `failed: 0`, `rows` and one `results[]` entry per row, each carrying its CSV `line`.

`dry_run: true` runs steps 1–3 only and returns `{ ok: true, dry_run: true, rows }`. It never reads or writes a Sheet, so the ledger-sheet-load check step can run it against a spreadsheet that still has the retired `is_loan` column.

## Choices and policy rules

- Family/subtype options and labels come from the Sheet. Active and locked rows remain available as new choices. Retired rows retain labels for displaying historical accounts.
- Category hints include every available subtype, including individual investment subtypes, and the established `investment` group shorthand. Their labels come from the Sheet.
- Locked rows permit an explicit lifecycle unlock; change descriptive/policy fields or delete only after unlocking. Update, delete and bulk-import paths apply the same checks.
- Deactivation/deletion is blocked while any account or category hint references the classification, including historical rows. The investment shorthand references investment classifications collectively.
- Changing `detail_sheet` is blocked once any account references the classification. Initial policy assignment during the 12-to-13-column upgrade comes from the approved CSV; extraction also checks existing database detail ownership.
- Available detail Sheet names are structural importer contracts, not a subtype catalog.

Direct Sheet edits queue pending sync and update the source timestamp. They remain subject to extractor validation; editing cells directly does not make an invalid identity or dependency safe.

## API

| Action | Behavior |
|---|---|
| `list_account_types_view` | GET view model for Configure: search / status / type filters, sort, labels, `has_accounts`, `readonly_fields`, `statuses_for_edit`, `allowed_actions`, `requires_migration`. |
| `export_account_types` | GET the whole catalog (every status, filters ignored) in the 13 import columns with existing UUIDs and `requires_migration`; Configure → Export previews and downloads it. It re-imports unchanged through `create_account_types_bulk`. |
| `list_account_types` | Raw rows with `_row` / `row_num`; empty list for an empty store; no seeding. Kept for the previous frontend only. |
| schema | Fields, family options, detail Sheet options, lifecycle values, ordered headers and `requires_migration` arrive in `get_app_context` (`schemas.account_type`); the separate `get_account_type_schema` route was removed. |
| `create_account_type` | Reject with `account_type_creation_restricted`. |
| `update_account_type` | Update an existing row; propagate a changed family label after validating all siblings. |
| `delete_account_type` | Dependency-checked soft deletion. |
| `restore_account_type` | Restore an existing deleted row to active. |
| `create_account_types_bulk` | Body `{ csv, dry_run? }`, parsed server-side by `importAccountTypesCsv` (see CSV import). Bootstrap an empty store or update existing UUIDs; accept the complete catalog for schema/key migration. The internal `createAccountTypesBulk({ account_types })` keeps the row-array form for `migrateAccountTypeKeys` and factory reset. |

Mutations carry `row_num` and the expected `id`; mismatches return `stale_row`. Authentication, script locking, and `{ok: true, ...}` / `{ok: false, error: ...}` envelopes follow the existing API conventions. Account schema responses retain legacy subtype arrays and add `subtypes_by_type`; labels include retired records while selectable arrays contain eligible records only.

## Retire classifications

Classifications are never removed by an import: an import only updates rows whose UUID already exists. To retire one (as with `bonds`, `commodities`, `isa`, `p2p-lending`, `medical-loan` and `student-loan` on 2026-09-29), keep its row and soft-delete it, in this order:

1. Import the updated `category_master.csv` that no longer lists the subtype in any hint, then run ledger-sheet-extract while the types are still active. Categories must release their links first: the app rejects `delete` with `account_type_in_use`, and ledger-sheet-extract rejects a retired type that database category links still reference (`referenced_type_cannot_be_retired`), which stops the run before categories are processed.
2. Soft-delete each type in Configure → Account Types, then run ledger-sheet-extract again.

Do not delete the Sheet rows. A physically removed row leaves the database copy active, Sheet-managed and in-sync, so extraction keeps accepting references to it.

## Upgrade an existing Sheet

1. Deploy the updated GAS backend and frontend. If master tabs still have their old names, run `migrateMasterSheetNames()` first.
2. In Configure → Account Types, import the **complete 13-column CSV**. The upgrade must list every UUID already in the legacy Sheet (`complete_account_type_catalog_required` otherwise), so a legacy Sheet that still holds the six classifications retired on 2026-09-29 cannot be upgraded with the current 16-row CSV: upgrade it with a complete catalog first, then retire them as described above. An old 12-column catalog remains readable, but choices and edits require this upgrade; policy values are never guessed from removed constants.
3. The import preflights every existing catalog identity plus account/category Sheet headers, UUIDs and references. Missing catalog rows, changed identities, normalization collisions, unknown references or malformed policies stop before writing.
4. The catalog's header and data rows are written together in the 13-column layout. Existing account `type` / `sub_type` and category hint tokens are normalized from underscores to hyphens, with sync state queued before key changes. Only changed reference cells and their sync/update fields are written: unrelated financial cells, formulas, UUIDs and creation timestamps are preserved.
5. Run ledger-sheet-extract after the Sheet upgrade. It processes account types before categories/accounts and applies its database migrations through the normal startup flow. See the [Sheet-to-database mapping](../../data-synchronization/ledger-sheet-extract/_docs/account-types.md).

An Apps Script editor alternative is `migrateAccountTypeKeys(catalogRows)`, passing the parsed complete CSV as an array of objects with all business/policy values. The helper uses the same preflight and holds a script lock. Running it again preserves identities and normalized references; as an import, it queues source catalog rows again.

Google Sheets writes across separate tabs are not atomic. If a service error interrupts the writes, the response is `account_type_import_failed`; retry the complete CSV. Reference updates check the physical row's UUID before each write. The retry still finds and normalizes remaining old references even if the catalog upgrade already succeeded. Do not resume extraction until the import completes.

Tests use mocked GAS services and synthetic fixtures. Editing this code does not deploy it or mutate a live Sheet.
