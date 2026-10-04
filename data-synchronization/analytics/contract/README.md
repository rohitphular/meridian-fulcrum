# Report contract

The single source for what a report can be and what the analytics job publishes. GAS, ledger-database-load and the analytics job all follow these files.

| File | What it defines |
|---|---|
| [report-definition.json](report-definition.json) | `report_master` columns, allowed values (measures, periods, compare, time steps, group-bys, filters, chart kinds), compatibility rules, limits, Home slot rules, validation error codes |
| [predefined-reports.json](predefined-reports.json) | Pre-built reports, Home numbers and internal datasets: stable `predefined_key`, fixed `report_master` UUID, periods, tabs, controls, drills, default Home layout |
| [report-payload.md](report-payload.md) | The published payload (money in XAU grams, UTC dates, no amounts inside text), variant keys, which values GAS converts, the GAS envelope |
| [sheet-tabs.json](sheet-tabs.json) | Every report tab: owner (app or analytics), columns, Home slots, payload chunk size, what factory reset does |
| [generate_seed.py](generate_seed.py), [seed/](seed) | The starting `report_master.csv` (every pre-built report) and `dashboard_layout.csv` (default Home) for a new ledger-sheet-load data folder |
| [generate_gas.py](generate_gas.py) | Writes `expense-tracker/api/report-contract.gs`, the copy GAS reads |

## Changing the contract

1. Edit the JSON (and the payload doc if the shape changes). Bump `contract_version` in every JSON file for any change that old data or code would not accept.
2. Regenerate the GAS copy and the seed files: `python3 data-synchronization/analytics/contract/generate_gas.py` and `generate_seed.py`.
3. Run `node --test expense-tracker/tests/report-contract.cjs`: it fails if the copy differs from the JSON or a cross-reference is broken.

Pre-built report ids are `uuid5(uuid_namespace, predefined_key)`. Never change a key or the namespace: the id is the `report_master` row that CSV backups and Home layouts refer to.
