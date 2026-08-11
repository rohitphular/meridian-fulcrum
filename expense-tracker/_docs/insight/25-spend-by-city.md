# Insight 25 — Spend by City

**File:** `sections/insights/25-spend-by-city.js`
**Group:** Spending analysis (geographic)
**Chart type:** Horizontal bar (`indexAxis: 'y'`) + stat table
**Tabs:** None (transactions view only — no tab strip)

---

## What it shows

`money-out` spend grouped by city — granular to location level. Domestic (UK) cities in teal, international in amber. Same structure as Insight 24 (country-level) one level deeper.

---

## City key construction

`_cityKey(tx)` builds a unique, display-ready label:

| `tx.city` | `tx.country` | Label |
|---|---|---|
| `"London"` | `"UK"` | `"London, United Kingdom"` |
| `"Mumbai"` | `"IN"` | `"Mumbai, India"` |
| `"Paris"` | `"FR"` | `"Paris, FR"` |
| `"London"` | _(blank)_ | `"London"` |
| _(blank)_ | `"UK"` | `"United Kingdom (city unknown)"` |
| _(blank)_ | _(blank)_ | `"Unknown"` |

`${city}, ${country}` composite key disambiguates same city name in different countries (e.g. `Paris, TX` vs `Paris, FR`).

Country normalisation uses the same lookup map as Insight 24 (`uk` / `gb` → `United Kingdom`, etc.).

---

## Computation

`_groupByCity(outTxs)`:
1. Groups `money-out` transactions by `_cityKey(tx)`.
2. Per group: `total = sumAmountBase`, `count`, `avg`, `topCat` (most frequent `major_category`).
3. Flags: `isDomestic = (country === 'United Kingdom')`, `isUnknown = label ends with '(city unknown)' or === 'Unknown'`.
4. Sort order: domestic cities (desc) → foreign cities (desc) → unknown rows.
5. Top `MAX_CITIES = 15`; remainder → `'Other'` aggregate (treated as unknown for colour).

---

## Chart

Horizontal bar identical in structure to Insight 24.

### Bar colours

| Row type | Colour |
|---|---|
| Domestic (United Kingdom) | `C.teal` |
| International | `#f59e0b` (amber) |
| Unknown / Other | `C.muted + '88'` |

A small colour legend (two inline swatches) is rendered above the chart since there is no Chart.js legend.

Canvas height: `Math.max(240, N × 44)` px.

Y-axis labels truncated to 20 chars; full label shown via `tooltip.title` callback (reads from `rows[ctx[0].dataIndex].label` — not the truncated chart label).

Tooltip: `£amount · N txns · TopCategory`.

---

## Stat table (below chart)

Horizontally scrollable. 5 columns: City | Spend | Txns | Avg/txn | Top category.

City label truncated to 24 chars in table (full name fits more often than in the chart Y-axis).

---

## Stat cards (4)

| Card | Value |
|---|---|
| Total spend | Sum of all known + unknown rows (excl. "Other") |
| Cities | Count of distinct non-unknown cities |
| Domestic | Total domestic spend + `(X%)` sub-line |
| International | Total foreign spend + `(X%)` sub-line |

---

## Edge cases

| Scenario | Behaviour |
|---|---|
| All city fields blank | All rows land in unknown-family; note "Add city to transactions for a richer view." shown |
| Blank city, known country | Label = `"${country} (city unknown)"` — distinct from raw `"Unknown"` |
| Same city name, different countries | Composite key `"${city}, ${country}"` keeps them separate |
| More than 15 cities | Remainder → `'Other'` aggregate at bottom, coloured grey |
| No spend transactions | `chart-empty` "No spend transactions for this period."; returns `null` |

---

## Shared utilities used

| Utility | Source |
|---|---|
| `sumAmountBase` | `insight-utils.js` |
| `getCssColors`, `baseChartOptions` | `insight-utils.js` |
