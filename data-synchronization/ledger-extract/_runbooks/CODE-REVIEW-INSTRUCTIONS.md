# ledger-extract review checklist

Read the current [README](../README.md), [usage](USAGE-INSTRUCTIONS.md), and standards under `building-standards/documents/standards/`: `APP-BE-PYTHON.md`, `APP-CONVENTIONS.md`, `APP-LOGGING-PATTERNS.md`, and `APP-CICD-BE-PYTHON.md`. Consult the current expense-tracker GAS schemas for the source contract. [`_docs/`](../_docs/README.md) maps every source column, derived/database-only column and retained legacy detail field. Verify it against those registries and the full migration chain; do not use stale generated models as authority.

Never print secrets or source financial rows. Review with fixtures and disposable databases; do not run live migrations, extraction or Sheet writebacks just to check code.

## Highest-risk checks

- Current headers match the schema registries; reordered metadata is resolved by name. Duplicate/invalid UUIDs fail before entity writes. Sparse gaps cannot hide later populated rows. Empty valid tabs cause no deletion. Every source guard reads all enabled whole-tab ranges in one batch; appended rows/columns remain visible. Count API calls at the spreadsheet boundary, and check pacing/retry behavior without real sleeps.
- Raw numeric values reach Decimal conversion without display-currency/locale parsing. Money is finite, correctly signed, rounded once to local storage precision, and bounded for BIGINT. Base conversion derives from those stored local units; XAU is one gram with nine decimal places.
- Account FX uses its dated tracking/opening snapshot. Transaction FX uses the exact UTC date. Missing rates produce failed rows; never substitute today's rate. Reprocessing applies corrected rates without changing immutable source money.
- Local timestamps resolve consistently across DB timezone settings. Invalid, ambiguous and nonexistent local times fail visibly.
- Stable source UUIDs and database surrogate UUIDs survive retries and lifecycle changes. Parent/child transfers remain valid when source rows are reversed or a parent is updated. Failed transfer legs roll back the group. Replacing beneficiary/category junctions is atomic with the master change.
- Deleted/inactive dependencies remain available to historical records. Restores and source-controlled unlocks can be replicated. Physical source removal is not interpreted as deletion.
- All six detail tabs preserve UUIDs and source fields in identically named tables; loan tables have independent ID namespaces. Six detail tabs use pending/failed/in-sync metadata, with missing-DB recovery and guarded sync-only acknowledgements. Hard-sync revalues supported current snapshots, and each selected tab batch rolls back atomically. Source audit timestamps must survive extractor acknowledgements and importer retries. Legacy rows are preserved; missing facts/history are not fabricated. Subtype changes cannot invalidate retained details or property links; reference locks must cover detail validation through commit.
- Acknowledgements occur after DB commit and affect only sync fields. Source audit timestamps remain untouched. Accounts recheck the source before each row commit; detail tabs recheck before their atomic commit. Header/source check failures must propagate without stale failure acknowledgements. Re-read guards detect changed/reordered source rows before acknowledgement; document the remaining check/write race.
- Job locking prevents overlapping extractors. Row failures make the process fail and prevent a successful checkpoint. Unchanged Drive timestamps cannot suppress rate/dependency retries or database recovery.
- Dependency outages/programming errors propagate; expected row errors roll back and produce useful redacted notes. Never log raw PostgreSQL exception detail (it can include full financial rows).
- Schema changes are additive and ordered. Migration 0005 must refuse to discard nonempty legacy history. Test currency migrations followed by every ledger migration against clean PostgreSQL.

## Required local validation

Run `make lint`, `make test-unit`, and `make test-integration`. Use the disposable PostgreSQL fixture, not dev/prod. Check fixture cleanup, no TCP listener, and explicit test connection parameters. Add regression tests for confirmed defects, including retry/failure paths—not assertions that merely repeat implementation details.

Check the committed lockfile, startup environment selection and `--reprocess` option. Runtime must not upgrade dependencies automatically. Confirm docs distinguish current behaviour, historic decisions, supported scope, and remaining integration prerequisites. Report concrete fixes, passed/failed/skipped checks, and unresolved risks without claiming the system is gap-free.
