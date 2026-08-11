# Insight 24 — Spend by Country

**File:** `sections/insights/24-spend-by-country.js`
**Group:** Spending analysis (geographic)
**Chart type:** Horizontal bar (`indexAxis: 'y'`) + stat table
**Tabs:** None (transactions view only — no tab strip)

---

## What it shows

Total `money-out` spend grouped by country — ranked highest to lowest. Answers "how much am I spending in each country?" Useful for tracking international spend, travel costs, and FX exposure.

---

## Country normalisation

`_normalise(raw)`:
- Blank / null → `'Unknown'`
- Applies a lookup map for common abbreviations before display:

| Input | Normalised |
|---|---|
| `uk`, `gb`, `england` | `United Kingdom` |
| `us`, `usa`, `america` | `United States` |
| `uae` | `UAE` |
| `in` | `India` |

- Other values: first character uppercased, rest unchanged.
- Normalisation is display-only — source data is never mutated.

---

## Computation

`_groupByCountry(outTxs)`:
1. Groups transactions by normalised country label.
2. Per country: `total = sumAmountBase(txs)`, `count`, `avg = total / count`, `topCat` = most frequent `major_category`.
3. Sort: known countries by `total` descending; `'Unknown'` always last.
4. Take top `MAX_COUNTRIES = 15`; remainder collapsed into `'Other'` aggregate row (total + count only, `topCat = '—'`).

---

## Chart

```js
{
  type: 'bar',
  indexAxis: 'y',
  datasets: [{ data: amounts, backgroundColor: colors, borderRadius: 4 }],
  options: {
    legend: { display: false },
    tooltip: { label: ctx => `${sym}${amount} · N txns` }
  }
}
```

Canvas height: `Math.max(240, N × 44)` px — grows with country count.

### Bar colours

`_barColors(rows, C)`:
- Known countries (ranked): alpha interpolated from `ff` (rank 0) to `55` (last rank), all on `C.teal` — creates a progressively lighter teal gradient down the chart.
- `'Unknown'` and `'Other'` rows: `C.muted + '88'` (grey).

---

## Stat table (below chart)

Horizontally scrollable on mobile (`overflow-x: auto`, `min-width: 420px`).

| Column | Content |
|---|---|
| Country | Normalised name; home country (United Kingdom) bolded |
| Spend | `sumAmountBase` in quote currency |
| Txns | Transaction count |
| Avg/txn | `total / count` |
| Top category | Most frequent `major_category` in that country |

No sort — static display, ordered by chart rank.

---

## Stat cards (4)

| Card | Value |
|---|---|
| Total spend | Sum of all `money-out` in period |
| Countries | Count of distinct known countries (excludes "Unknown" and "Other") |
| Top country | Name + spend as `stat-card-sub` |
| Top country % | `topCountry.total / total × 100` |

---

## Edge cases

| Scenario | Behaviour |
|---|---|
| All transactions missing country | Only `'Unknown'` row; amber note: "Country data missing — add it when entering transactions." |
| Single country | One bar rendered; no special treatment |
| Name variations (`UK` vs `United Kingdom`) | Normalised via lookup map before grouping |
| More than 15 countries | Remainder collapsed into `'Other'` row at bottom |
| `money-transfer` txs | Excluded — only `money-out` counted |
| No spend transactions | `chart-empty` "No spend transactions for this period."; returns `null` |

---

## Shared utilities used

| Utility | Source |
|---|---|
| `sumAmountBase` | `insight-utils.js` |
| `getCssColors`, `baseChartOptions` | `insight-utils.js` |
