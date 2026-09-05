# Insight 28 — Foreign Currency Spend

**File:** `sections/insights/28-forex-spend.js`
**Group:** FX & currency
**Chart type:** Doughnut (By Currency)
**Tabs:** None

---

## What it shows

All outgoing transactions broken down by the native transaction currency. Answers:
- What fraction of spend is in foreign currencies vs domestic (quote currency)?
- What currencies are used and how much in each?
- What currencies are used and how much in each?

---

## Data source

```js
const outTxs = txs.filter(t => t.tx_type === 'money-out');
```

Grouped by the linked account's `local_currency` (derived as `accountMap.get(tx.account_id).local_currency`, trimmed, uppercased). Falls back to `state.quoteCurrency` when no matching account is found.

---

## Computation (`_groupByCurrency`)

For each currency group:

| Field | Source |
|---|---|
| `nativeTotal` | `txs.reduce((s, t) => s + Math.abs(t.tx_amount_local), 0)` — sum in native currency |
| `baseEquiv` | `sumAmountBase(txs)` — sum converted to base currency (XAU) via `toBase(tx.tx_amount_local, account.local_currency)` |
| `count` | `txs.length` |
| `avgRate` | `state.rateMap[ccy]` — the current global rate for the currency; `null` when not in rateMap |
| `hasEstimated` | Always `false` — `tx.fx_rate` is not a stored field; rates come from `state.rateMap` only |
| `rateUnavail` | `true` when foreign and `avgRate === null` |

Rows sorted descending by `gbpEquiv`. Domestic currency (`state.quoteCurrency`) is included in the list.

---

## Stat cards (4)

| Card | Value |
|---|---|
| Currencies used | Distinct currency count |
| Domestic (`quoteCcy`) | Base-currency total + % of all spend |
| Foreign spend | Non-domestic base-currency equiv + % |
| Largest foreign | Currency code + base-currency equiv sub-line; `—` if none |

The stat cards are always visible.

---

## By Currency sub-view (default)

### Doughnut chart

- `type: 'doughnut'`, `cutout: '60%'`
- One segment per currency, `buildPalette(C)` colours cycling at index 8+
- Canvas height: `220px`
- Legend: `position: 'bottom'`, `boxWidth: 12`
- Tooltip: native amount + base-currency equiv + percentage

### Currency table

| Column | Notes |
|---|---|
| Currency | Colour swatch + bold code |
| Native total | Sum in native currency with `_ccySym` prefix |
| Base equiv | `~` prefix when any rates were estimated from `rateMap`; `⚠` when rate unavailable |
| Txns | Count |
| Avg rate | 4 decimal places; `—` when unavailable |

Table is wrapped in `overflow-x: auto` with `min-width: 380px` for mobile scroll.

---

## Module-level chart state

Same pattern as insights 21 and 22:

```js
let _chart = null;

function _setChart(c) {
  if (_chart && _chart !== c) { try { _chart.destroy(); } catch(_e) {} }
  _chart = c;
  state.insightChartInstance = c;
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
| Only domestic spend | Foreign stat card = `£0 (0%)` |
| No matching account for `tx.account_id` | Currency treated as `state.quoteCurrency` |
| No stored `fx_rate` on transaction | `fx_rate` is not a stored field — base-currency equiv is always computed via `toBase(tx.tx_amount_local, account.local_currency)` using the current `rateMap`. `hasEstimated` is hardcoded `false`; the `~` prefix never appears. |
| Currency not in `rateMap` | `⚠` warning badge in table; scatter point omitted (no `fx_rate`) |
| > 8 currencies | `buildPalette` colours cycle (8-colour palette repeats) |
