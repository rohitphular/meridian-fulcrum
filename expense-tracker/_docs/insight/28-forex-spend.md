# Insight 28 — Foreign Currency Spend

**File:** `sections/insights/28-forex-spend.js`
**Group:** FX & currency
**Chart type:** Doughnut (By Currency) + Scatter (FX Rates)
**Tabs:** None — internal pill tabs managed by the insight itself

---

## What it shows

All outgoing transactions broken down by the native transaction currency. Answers:
- What fraction of spend is in foreign currencies vs domestic (GBP)?
- What currencies are used and how much in each?
- How have FX rates fluctuated over the period for each foreign currency?

---

## Internal sub-views (pill tabs)

Two pill buttons rendered inside the insight, not in the coordinator tab strip. Attribute pattern: `data-d28-view="currency"` and `data-d28-view="fx-rates"`.

The "FX Rates" pill is **only rendered** when at least one foreign-currency transaction has `fx_rate` populated. If no scatter data exists, only "By Currency" is available.

---

## Data source

```js
const outTxs = txs.filter(t => t.transaction_type === 'money-out');
```

Grouped by `tx.currency` (trimmed, uppercased). Falls back to `state.quoteCurrency` when `tx.currency` is blank.

---

## Computation (`_groupByCurrency`)

For each currency group:

| Field | Source |
|---|---|
| `nativeTotal` | `txs.reduce((s, t) => s + Math.abs(t.amount), 0)` — sum in native currency |
| `gbpEquiv` | `sumAmountBase(txs)` — sum of `amount_base` (pre-converted to GBP) |
| `count` | `txs.length` |
| `avgRate` | Mean of `t.fx_rate` for txs that have it; falls back to `state.rateMap[ccy]` |
| `hasEstimated` | `true` when any tx in the group is missing `fx_rate` (foreign only) |
| `rateUnavail` | `true` when foreign and `avgRate === null` |

Rows sorted descending by `gbpEquiv`. Domestic currency (`state.quoteCurrency`) is included in the list but does not generate FX rate scatter points.

---

## Stat cards (4)

| Card | Value |
|---|---|
| Currencies used | Distinct currency count |
| Domestic (`quoteCcy`) | GBP total + % of all spend |
| Foreign spend | Non-domestic GBP equiv + % |
| Largest foreign | Currency code + GBP equiv sub-line; `—` if none |

The stat cards are always visible regardless of active sub-view.

---

## By Currency sub-view (default)

### Doughnut chart

- `type: 'doughnut'`, `cutout: '60%'`
- One segment per currency, `buildPalette(C)` colours cycling at index 8+
- Canvas height: `220px`
- Legend: `position: 'bottom'`, `boxWidth: 12`
- Tooltip: native amount + GBP equiv + percentage

### Currency table

| Column | Notes |
|---|---|
| Currency | Colour swatch + bold code |
| Native total | Sum in native currency with `_ccySym` prefix |
| GBP equiv | `~` prefix when any rates were estimated from `rateMap`; `⚠` when rate unavailable |
| Txns | Count |
| Avg rate | 4 decimal places; `—` when unavailable |

Table is wrapped in `overflow-x: auto` with `min-width: 380px` for mobile scroll.

---

## FX Rates sub-view

Scatter chart — one dataset per foreign currency that has at least one `fx_rate` value.

| Axis | Value |
|---|---|
| X | `new Date(tx.transaction_date_utc).getTime()` (ms epoch), rendered as `"Jul '26"` via tick callback |
| Y | `tx.fx_rate` (4 decimal places) |

No date adapter dependency — X scale is `type: 'linear'` with a `ticks.callback` that formats timestamps with `toLocaleDateString`.

**Mobile:** `pointRadius: 6`, `pointHoverRadius: 8` for comfortable touch targets.

**Edge case:** If no foreign transactions have `fx_rate`, the sub-view shows a `chart-empty` message and the "FX Rates" pill is hidden entirely.

---

## Module-level chart state

Same pattern as insights 21 and 22:

```js
let _chart = null;

function _setChart(c) {
  if (_chart && _chart !== c) { try { _chart.destroy(); } catch(_e) {} }
  _chart = c;
  state.dashChartInstance = c;
}
```

`_chart = null` is reset at the top of `render()` to clear stale refs from prior renders. Both sub-view renderers call `_setChart()` after creating their Chart instance.

---

## Currency symbol map (`CCY_SYMBOL`)

Module-level constant covering common currencies: GBP £, USD $, EUR €, INR ₹, JPY ¥, AUD A$, CAD C$, CHF, SGD S$, AED, HKD, NZD, SEK/NOK/DKK kr. Unknown currencies fall back to `"CCY "` (code + space).

---

## Shared utilities used

| Utility | Source |
|---|---|
| `sumAmountBase` | `insight-utils.js` |
| `getCssColors`, `buildPalette` | `insight-utils.js` |

---

## Edge cases

| Scenario | Behaviour |
|---|---|
| No `money-out` transactions | `chart-empty` "No spend transactions for this period." |
| Only domestic spend | Foreign stat card = `£0 (0%)`; no "FX Rates" pill |
| `tx.currency` blank | Treated as `state.quoteCurrency` |
| `fx_rate` null for foreign tx | GBP equiv uses `amount_base`; avg rate falls back to `rateMap`; `~` prefix on table GBP equiv |
| Currency not in `rateMap` | `⚠` warning badge in table; scatter point omitted (no `fx_rate`) |
| > 8 currencies | `buildPalette` colours cycle (8-colour palette repeats) |
