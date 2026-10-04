# analytics — code review checklist

- **One snapshot.** Every source read happens inside the build's REPEATABLE READ transaction (a `BUILD_STEPS` entry), never on a second connection or after the commit.
- **No partial output.** A failing step must raise: the transaction rolls back and the run is `failed`. Steps never commit.
- **Locks.** Only `(73421, 3)`; never the load's `(73421, 1)` or extract's `(73421, 2)`.
- **Contract first.** Measures, periods, group-bys, payload shape and Sheet tabs come from `contract/`; a change there bumps `contract_version` and regenerates the GAS copy (`make contract`).
- **XAU and UTC.** Money in XAU; dates as UTC dates; no display-currency conversion and no local time in this module.
- **Safe logs.** `func: key=value` with codes, counts and ids only. Error messages that reach the run row or the log are snake_case codes (`core.build.error_code`); anything else becomes `see_module_logs`.
- **Tests.** Unit tests for pure logic; integration tests against the disposable PostgreSQL for anything that reads the ledger.
