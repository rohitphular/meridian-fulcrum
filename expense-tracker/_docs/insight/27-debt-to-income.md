# Insight 27 — Debt-to-Income Ratio

**File:** `sections/insights/27-debt-to-income.js`
**Group:** Account & net worth
**Chart type:** Gauge (half-donut) + trend line / Income bar chart
**Tabs:** Both — Accounts tab (current DTI + trend) / Transactions tab (income context)

---

## What it shows

Debt-to-income ratio: `totalDebt / annualisedIncome × 100`. A standard personal finance health metric. Below 36% is healthy; above 50% is high risk.

---

## DTI thresholds

| Range | Status | Colour |
|---|---|---|
| < 20% | Excellent | `#34d399` (green) |
| 20–36% | Good | `C.teal` |
| 36–50% | Caution | `#f59e0b` (amber) |
| > 50% | High risk | `C.ember` |

---

## Accounts tab

### Computation

| Value | Source |
|---|---|
| `totalDebt` | `computeDailyTotalAssets(liabAccts, state.transactions, todayLocal, todayLocal)[0]` — `Math.abs` |
| `monthlyIncome` | Mean of per-month `money-in` sums, **excluding the current (partial) calendar month** |
| `annualisedIncome` | `monthlyIncome × 12` |
| `dtiRatio` | `totalDebt / annualisedIncome × 100` — `null` when no income |
| Monthly DTI trend | `_buildMonthlyDTI`: one `computeDailyTotalAssets` pass for all liability accounts, sampled at month-ends |

Partial month exclusion: `completeMKs = monthKeys.filter(mk => mk !== curYYYYMM)`.

### Gauge (half-donut)

```js
{
  type: 'doughnut',
  data: { datasets: [{ data: [dtiVal, 100 - dtiVal], backgroundColor: [gaugeColor, C.hair] }] },
  options: { rotation: -90, circumference: 180, cutout: '75%',
             legend: { display: false }, tooltip: { enabled: false } }
}
```

`dtiVal = Math.min(dtiRatio, 100)` — caps at 100% for rendering even if ratio exceeds it.

Canvas height: `200px`. The half-circle occupies the upper portion; text overlay sits at the doughnut-hole centre (lower-center of the canvas).

**Centre text overlay:** absolute-positioned `<div>` inside a `position:relative` wrapper:
- Large value: `"38.2%"` (or `"N/A"`) in the threshold colour
- Sub-label: `"Caution"` / `"Excellent"` / `"Debt-free"` in `var(--muted)`
- `pointer-events: none` so clicks pass through to canvas

### DTI trend line

Line chart showing monthly DTI % over the selected period. Canvas height: `220px`.

Reference line at 36% drawn via an inline Chart.js plugin (`_refLinePlugin`):
```js
afterDraw(chart) {
  const y = scales.y.getPixelForValue(36);
  ctx.setLineDash([5, 5]);
  ctx.strokeStyle = '#f59e0b99';
  // draw horizontal line from chartArea.left to chartArea.right
}
```

No annotation plugin dependency — pure canvas draw.

`spanGaps: false` — months with `null` DTI (no income) render as gaps.

### Stat cards (4)

| Card | Value |
|---|---|
| Total debt | Current liability balance |
| Monthly income (avg) | Mean from complete months |
| Annualised income | `monthlyIncome × 12` |
| DTI ratio | `X.X%` in threshold colour |

---

## Transactions tab

Monthly income bar chart (income context for the DTI denominator).

Stat cards (4): Total income | Avg monthly | Annualised | Peak month (with amount sub-line).

Bar chart: `backgroundColor: rgba(52,211,153,0.75)`, canvas height `240px`.

---

## Multi-chart proxy

Both tabs return `_proxy([chart1, chart2])`:
```js
function _proxy(charts) {
  return { destroy() { charts.forEach(c => { try { c?.destroy(); } catch(_e){} }); } };
}
```

Accounts tab creates up to 2 charts (gauge + trend); Transactions tab creates 1 (income bar). The proxy destroys whichever are non-null.

---

## Shared utilities used

| Utility | Source |
|---|---|
| `monthRange`, `groupByMonth`, `sumAmountBase` | `insight-utils.js` |
| `computeDailyTotalAssets` | `insight-utils.js` |
| `getCssColors`, `baseChartOptions`, `fmtMonthKey` | `insight-utils.js` |

---

## Edge cases

| Scenario | Behaviour |
|---|---|
| No liability accounts | `totalDebt = 0`; gauge at 0%; status = `"Debt-free"` |
| No income in period | `dtiRatio = null`; gauge at 0%; shows `"N/A"` + amber note |
| DTI > 100% | `dtiVal = 100` (gauge full); label shows true ratio e.g. `"142.5%"` |
| Partial current month | Excluded from income average via `curYYYYMM` check |
| All months partial (YTD, first month of year) | Falls back to using all months |
| Trend month with no income | DTI = `null`; `spanGaps: false` renders as line gap |
