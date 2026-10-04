# 12 — Publisher

**Depends on:** 08, 10, 11.

## Steps
1. Write the inactive slot completely (`report_index_x`, `report_data_x`), chunking payloads (≤ 45,000 chars per cell, RAW), pre-sizing the grid, paced batched writes.
2. Write `report_status`, then flip `report_meta.active_slot` + `generation_id` + `published_at` last. A failure before the flip leaves the previous generation live.
3. Skip publishing when watermarks (ledger, rates, definitions) are unchanged since the last published generation.
4. `publish` mode re-publishes the last good generation from `report_output`.
5. Measure: request count, bytes, duration; respect Sheets limits (cells, request size).

## Acceptance
- Killing the job mid-publish leaves the app showing the previous generation; integration test with a fake Sheets client.
