# Insight 15 — Account Balances Snapshot

**File:** `sections/insights/15-account-balances.js`
**Group:** Net worth
**Chart type:** Horizontal bar — three separate sections (Assets / Liabilities / Investments)
**Tabs:** None (accounts view only — no tab strip)

---

## What it shows

Current balance of every active account, grouped by type — a single-screen view of the full financial picture as of today.

---

## Key differences from other insights

- **No period** — ignores coordinator's `from`/`to`. Always shows today's balance.
- **Three Chart instances** — one per section. Returns a `_proxy` object with `.destroy()` so the coordinator can clean up all three on navigation.
- **Per-account balance computation** — calls `computeDailyTotalAssets([account], ...)` for each account individually to get the transaction-accurate current balance.

---

## Balance computation

`_currentBalance(account)`:
```js
const todayLocal = new Date(today.getFullYear(), today.getMonth(), today.getDate());
const daily      = computeDailyTotalAssets([account], state.transactions, todayLocal, todayLocal);
return daily[0] || 0;
```

Single-day range (`from = to = today`). `computeDailyTotalAssets` replays all transactions chronologically on the first (only) day iteration, giving the correct balance as of end-of-today.

Called once per active account. For a personal app with ~20 accounts, this is O(20 × M) — negligible.

---

## Account partitioning

| Section | Condition | Sort |
|---|---|---|
| Assets | `!liabilityTypes.has(type) && !investmentTypes.has(type)` | Balance descending |
| Liabilities | `liabilityTypes.has(type)` (from `state.accountSchema.liability_types`) | Most negative first |
| Investments | `type === 'investment'` | Balance descending |

Investments section is omitted entirely from the DOM if there are no investment accounts.

---

## Multi-chart proxy

```js
function _proxy(charts) {
  return { destroy() { charts.forEach(c => c?.destroy()); } };
}
```

The coordinator does `state.insightChartInstance.destroy()` before switching insights. The proxy forwards `.destroy()` to all three Chart instances. The coordinator never needs to know there are multiple charts.

---

## Section HTML

Each section: header row (`title` left + `total` right) + canvas. Canvas height: `max(80, rows × 40 + 40)px` — grows with account count.

---

## Chart per section

```js
{
  type: 'bar',
  indexAxis: 'y',
  datasets: [{ data: balances (as absolute values), backgroundColor: sectionColor }],
  legend: { display: false },
}
```

Colors:
- Assets: `C.teal`
- Liabilities: `rgba(248,113,113,0.8)` — ember red
- Investments: `rgba(251,191,36,0.8)` — amber

---

## Stat cards (4)

| Card | Value |
|---|---|
| Assets | Sum of asset account balances |
| Liabilities | Sum of `Math.abs(liability balances)` |
| Investments | Sum of investment balances |
| Net worth | `assets + investments − liabilities` |

---

## Shared utilities used

| Utility | Source |
|---|---|
| `computeDailyTotalAssets` | `insight-utils.js` |
| `getCssColors`, `baseChartOptions` | `insight-utils.js` |

---

## Edge cases

| Scenario | Behaviour |
|---|---|
| No active accounts | `chart-empty` "No active accounts found."; returns `null` |
| No investment accounts | Investment section omitted from DOM; `_renderSection` returns `null` (filtered from proxy) |
| No liability accounts | Section shows "No liability accounts." plain text |
| Account with zero balance | Bar = 0; account still listed in section |
| Foreign-currency account with missing rate | `computeDailyTotalAssets` uses `toBase` which returns 0 for missing rates — account appears as £0 |
