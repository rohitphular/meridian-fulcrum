# 07 — Sync rates to the Sheet

**Depends on:** 02, and the shared paced Sheets client (task 08 step 6).

## Goal
GAS converts XAU to the display currency using rates that come from PostgreSQL.

## Steps
1. New forex-database-load mode `publish-sheet` (service-account Sheets API with the shared paced client; `spreadsheet_id` per env in its `cicd/envs.json`; service-account key path in `infrastructure/.env.<env>` with the `FDL_` prefix): write the latest rate per tracked currency (XAU = 1) with its `rate_date` and symbol to the `rates` tab via the service-account Sheets API.
2. GAS: rates become read-only — remove `upsertRate`/`deleteRate` and their routes; the Rates screen shows rates and their date only.
3. Missing rate for a display currency → GAS returns values with a `missing_rate` warning (no 1:1 fallback).
4. Update `_docs/rates.md`, data-sync README (the "rates tab is not synced" note), tests.

## Acceptance
- After a run the `rates` tab matches the latest Postgres rates; the app cannot edit rates.
