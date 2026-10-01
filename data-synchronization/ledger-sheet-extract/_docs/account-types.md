# Account types

`account_types.csv` → Sheet `account_types` → PostgreSQL `account_types`.

The Sheet supplies the existing classification catalog, its labels, lifecycle and processing policies. There is no runtime subtype catalog or default seed. Initialize the Sheet from the current CSV in Configure → Account Types and sync it before dependent categories, accounts or details. The checked-in configuration enables this entity first; older configs without the toggle leave it disabled and must opt in before initial setup or policy migration.

## Column mapping

The source contract has thirteen columns, in this order. Database-only fields are listed last.

| Sheet column | Database column | Processing |
|---|---|---|
| `id` | `id` | Required UUID; preserved after canonical formatting. See bounded initial adoption below. |
| `account_type_key` | `account_type_key` | Existing catalog group key; lowercase ASCII words joined by hyphens. Immutable for a stored identity. |
| `account_type_label` | `account_type_label` | Required trimmed label; every source row in the same group must agree, including inactive/deleted rows. |
| `account_subtype_key` | `account_subtype_key` | Existing catalog subtype key, using the same hyphen format. Globally unique; cannot equal any configured group key. Immutable for a stored identity. |
| `account_subtype_label` | `account_subtype_label` | Required trimmed label. |
| `description` | `description` | String text only; blank becomes NULL. |
| `detail_sheet` | `detail_sheet` | Optional exact name of one of the six supported detail tabs; blank becomes NULL and enables no detail importer. Eligibility follows this value, independently of the subtype spelling. |
| `record_status` | `record_status` | Required `active`, `inactive`, `deleted` or `locked`. Active and locked rows can supply references. |
| `sync_status` | `sync_status` | Source selects processing. A committed database row records `in-sync`; source acknowledgement follows commit and a source check. |
| `sync_date` | `sync_date` | Source value is not copied. The extractor records the UTC successful attempt time. |
| `sync_notes` | `sync_notes` | Source value is not copied. Successful ingestion clears it; source failure acknowledgements contain a safe error code. |
| `created_at` | `created_at` | Source audit value is not copied or overwritten. Existing database creation time remains unchanged. |
| `updated_at` | `updated_at` | Source audit value is not copied or overwritten. Database update time describes successful ingestion. |
| — | `is_sheet_managed` | Initially false for historical reference data; becomes true after successful source adoption. Existing ownership survives migrations. |

Valid `detail_sheet` values are `account_deposit`, `account_investment_property`, `account_investment_stocks`, `account_liability_credit_card`, `account_liability_mortgage` and `account_liability_personal_loan`. These are structural import contracts, not a subtype catalog. See [account details](account-details.md) for their columns.

## Migration and identity

Migration `0019` adds ownership/sync metadata and makes category type references cascade UUID updates. Migration `0020` converts existing group/subtype key values from underscores to hyphens, cascades account-master composite-key references, and appends `is_loan` and `detail_sheet` without moving database columns. UUIDs, category links, ownership and audit timestamps remain intact. Key collisions or invalid converted keys abort atomically with `account_type_hyphen_keys_require_reconciliation`.

Migration `0020` deliberately leaves policy as false/NULL and clears the database sync state with `policy_source_sync_required`. These temporary defaults do not authorize references: account/category/detail lookups require completed Sheet ownership and policy sync. The next normal-sync reprocesses source rows even if their Sheet status was already `in-sync`, obtains the actual policy values, and preserves existing UUID ownership. Upgrade/import the current Sheet contract first; an old twelve-column header fails safely. Migration `0022` drops the unused `is_loan` column that `0020` added; a Sheet that still has `is_loan` fails with `account_types_is_loan_column_present` until that column is deleted.

Only an existing database classification can be synchronized. Its natural key is the group/subtype pair. An unmanaged existing row can adopt the source UUID once if that UUID does not belong to another classification. The UUID update, cascaded category links, labels, policy and ownership commit together after the source guard succeeds. Accounts retain their natural-key relationship. This supports existing installations with historical random IDs without a hardcoded list of eligible seeds.

Once managed, a different UUID cannot claim that classification. Keys cannot change through a Sheet edit. Unknown natural keys fail as `classification_not_in_existing_catalog`; this extractor never invents or inserts new classifications, including a source row whose database classification was physically deleted. Restore/reconcile the intended catalog before retrying. Rows absent from the Sheet are retained in the database; unmanaged rows remain unavailable to dependency lookups.

## Policy, lifecycle and synchronization

Normal-sync skips existing source `in-sync` rows whose database ownership and policy ingestion are complete. Pending/failed rows and rows requiring initial adoption/policy refresh are processed. Hard-sync includes existing in-sync rows, preserving identity. Failures stop downstream entities after recording safe row failures.

Retiring a classification (`inactive`/`deleted`) fails with `referenced_type_cannot_be_retired` while database category links still reference it, and account types are processed before categories. Sync the updated categories first, then the retired types; see [Retire classifications](../../../expense-tracker/_docs/account-types.md#retire-classifications). Rows removed from the Sheet are not retired in the database.

A `detail_sheet` mapping cannot change once any account references the classification, including historical/deleted accounts. Initial policy assignment after migration is permitted, but retained extension rows and linked-property references must already fit the chosen mapping. Account subtype changes likewise cannot orphan extension rows or property links.

`inactive` and `deleted` cannot be applied while any account or category source/target mapping references the classification, including historical records. `locked` is frozen configuration in the application and remains reference-eligible. Account/category lookups accept only active/locked, Sheet-managed, successfully synchronized types. Detail writes also require synchronized policy. Shared row locks preserve that policy through dependent commits.

An enabled category normal-sync compares existing `in-sync` categories using the broad `investment` hint with the currently eligible configured type IDs. Only changed junction sets are refreshed; unchanged categories skip. Synchronizing an existing investment classification into source ownership therefore updates these groups on the next enabled category run. Disabled categories defer the refresh. Each dependency refresh rechecks the source before commit; resulting category references also block retirement.

Source guard failures roll back the current configuration row and its cascaded changes without stale acknowledgements. Buffered Sheet updates touch only `sync_status`, `sync_date` and `sync_notes`, following the existing quota policy. Database commit followed by failed Sheet acknowledgement is safe to retry. Database `in-sync` describes committed ingestion, not proof of source acknowledgement. Tests use disposable PostgreSQL and mocked Sheets only.
