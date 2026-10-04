# 13 — Pipeline integration

**Depends on:** 08, 12.

## Steps
1. In `pipeline.example.json`: add `forex-database-load publish-sheet` right after `forex-database-load daily`, and `analytics refresh` as the last stage (after acknowledge; no `run_after_failure`, so a failed load never publishes).
2. Monitor card in `consolidated-pipeline/output/index.html` (reports ok/failed, rows not loaded, missing currencies, published_at).
3. Root Makefile picks the module up automatically (`data-sync` target); document standalone runs for the owner's scheduling (D1).

## Acceptance
- A dev pipeline run ends with a published generation and a monitor card.
