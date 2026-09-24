# Configure — Account Types

Configure → Account Types manages existing account classifications in a collapsible panel. It uses the same toolbar, filters, forms, status icons, row menus and mobile cards as the other modules. The CSV, Sheet tab and database table are named `account_types`. Classification keys use lower-case hyphenated values, such as `stocks-shares`; column names and Sheet names keep their existing underscores.

## Source catalog and identity

The Sheet supplies classification keys, labels, loan flags and detail-import eligibility. There is no application seed, fixed family catalog, hardcoded subtype count or embedded loan/subtype mapping. An absent or empty Sheet lists no rows and creates nothing on GET. Import the supplied complete `local/files/account_types.csv` to bootstrap it.

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
| 7 | `is_loan` | Required explicit boolean. Sheet booleans or CSV `true` / `false` are accepted; blank does not imply a policy. |
| 8 | `detail_sheet` | Blank or one of the six supported detail Sheet names exposed by the import registry. Controls detail-import eligibility. |
| 9 | `record_status` | `active`, `inactive`, `deleted` or `locked`. |
| 10 | `sync_status` | Server-owned pending/success/failure status. |
| 11 | `sync_date` | Cleared on a source mutation; extractor acknowledgement timestamp. |
| 12 | `sync_notes` | Cleared on a source mutation; safe extractor outcome. |
| 13 | `created_at` | Source creation timestamp; preserved on replacement and upgrade. |
| 14 | `updated_at` | Refreshed on source mutation/direct business edit. |

The final six columns retain the shared lifecycle/sync/audit order. Import/export use all 14 columns. Imported sync/audit values cannot mark a mutation as synchronized: the backend owns those values. All candidates, identities, policies and required dependent references are checked before any write. Invalid batches have no partial row success.

## Choices and policy rules

- Family/subtype options, labels and loan membership come from the Sheet. Active and locked rows remain available as new choices. Retired rows retain labels for displaying historical accounts.
- Category hints include every available subtype, including individual investment subtypes, and the established `investment` group shorthand. Their labels come from the Sheet.
- Locked rows permit an explicit lifecycle unlock; change descriptive/policy fields or delete only after unlocking. Update, delete and bulk-import paths apply the same checks.
- Deactivation/deletion is blocked while any account or category hint references the classification, including historical rows. The investment shorthand references investment classifications collectively.
- Changing `detail_sheet` is blocked once any account references the classification. Initial policy assignment during the 12-to-14-column upgrade comes from the approved CSV; extraction also checks existing database detail ownership.
- `is_loan` is configurable on an unlocked row and determines the app's loan membership. It does not create a detail contract. Available detail Sheet names are structural importer contracts, not a subtype catalog.

Direct Sheet edits queue pending sync and update the source timestamp. They remain subject to extractor validation; editing cells directly does not make an invalid identity or dependency safe.

## API

| Action | Behavior |
|---|---|
| `list_account_types` | Read existing rows with `_row` / `row_num`; return an empty list for an empty store. No seeding. |
| `get_account_type_schema` | Return fields, Sheet-derived family options, detail Sheet options, lifecycle values, ordered headers and `requires_migration`. |
| `create_account_type` | Reject with `account_type_creation_restricted`. |
| `update_account_type` | Update an existing row; propagate a changed family label after validating all siblings. |
| `delete_account_type` | Dependency-checked soft deletion. |
| `restore_account_type` | Restore an existing deleted row to active. |
| `create_account_types_bulk` | Bootstrap an empty store or update existing UUIDs; accept the complete catalog for schema/key migration. |

Mutations carry `row_num` and the expected `id`; mismatches return `stale_row`. Authentication, script locking, and `{ok: true, ...}` / `{ok: false, error: ...}` envelopes follow the existing API conventions. Account schema responses retain legacy subtype arrays and add `subtypes_by_type`; labels include retired records while selectable arrays contain eligible records only.

## Upgrade an existing Sheet

1. Deploy the updated GAS backend and frontend. If master tabs still have their old names, run `migrateMasterSheetNames()` first.
2. In Configure → Account Types, import the **complete 14-column CSV**. An old 12-column catalog remains readable, but choices and edits require this upgrade; policy values are never guessed from removed constants.
3. The import preflights every existing catalog identity plus account/category Sheet headers, UUIDs and references. Missing catalog rows, changed identities, normalization collisions, unknown references or malformed policies stop before writing.
4. The catalog's header and data rows are written together in the 14-column layout. Existing account `type` / `sub_type` and category hint tokens are normalized from underscores to hyphens, with sync state queued before key changes. Only changed reference cells and their sync/update fields are written: unrelated financial cells, formulas, UUIDs and creation timestamps are preserved.
5. Run ledger-extract after the Sheet upgrade. It processes account types before categories/accounts and applies its database migrations through the normal startup flow. See the [Sheet-to-database mapping](../../data-synchronization/ledger-extract/_docs/account-types.md).

An Apps Script editor alternative is `migrateAccountTypeKeys(catalogRows)`, passing the parsed complete CSV as an array of objects with all business/policy values. The helper uses the same preflight and holds a script lock. Running it again preserves identities and normalized references; as an import, it queues source catalog rows again.

Google Sheets writes across separate tabs are not atomic. If a service error interrupts the writes, the response is `account_type_import_failed`; retry the complete CSV. Reference updates check the physical row's UUID before each write. The retry still finds and normalizes remaining old references even if the catalog upgrade already succeeded. Do not resume extraction until the import completes.

Tests use mocked GAS services and synthetic fixtures. Editing this code does not deploy it or mutate a live Sheet.
