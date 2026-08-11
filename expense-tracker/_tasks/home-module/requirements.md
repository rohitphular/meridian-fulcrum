# Home — Requirements

## Overview

A new **Home** tab — the first tab in the nav. Computed locally from transaction and account data already loaded in state. No insights API involved.

Contains two independent cards stacked vertically (full width on mobile). Each card has its own timeframe selector.

---

## Timeframe Options

Both cards share the same set of timeframe options (user selects independently per card):

- Last 90 days
- This month
- Last month
- Last 3 months
- Last 6 months
- Last 12 months
- This quarter
- Last quarter
- Year to date
- Last year

---

## Card 1 — Income Trend

**Computed from:** money-in transactions for the selected timeframe.

### Stat Cards
| Label | Value |
|-------|-------|
| Total Income | Sum of all money-in transactions in the period |
| Avg Monthly | Total income / number of months in the period |
| Annualised | Avg monthly × 12 |
| Peak Month | Month name + year with highest income, and its amount |

### Chart
- Type: `bar`
- X axis: months within the selected period
- Y axis: total income per month (£)
- One bar per calendar month

---

## Card 2 — Debt-to-Income (DTI) Ratio

**Computed from:** liability account balances (total debt) + money-in transactions (income). No timeframe filter on debt — always uses current outstanding liability balances.

### Gauge
- Semicircle gauge showing current DTI %
- DTI = Total Debt / Annualised Income × 100
- Risk label below the % value:
  - ≤ 36%: Healthy
  - 37–50%: Moderate
  - > 50%: High risk
- Color: green (healthy) → amber (moderate) → red (high risk)

### Stat Cards
| Label | Value |
|-------|-------|
| Total Debt | Sum of all liability account balances |
| Monthly Income (Avg) | Avg monthly income for the selected timeframe |
| Annualised Income | Avg monthly × 12 |
| DTI Ratio | Total Debt / Annualised Income × 100 |

### Chart
- Type: `line`
- X axis: months within the selected period
- Y axis: DTI % per month
- One line: DTI trend
- Dashed reference line at 36% (healthy threshold) labelled "36% healthy threshold"

---

## General Rules

- Both cards computed locally — no API calls beyond the data already in state (transactions, accounts, rates).
- Timeframe selector per card, not global.
- Mobile-first: cards stack vertically, stat cards wrap to 2×2 grid on small screens.
- Respects quote currency and rate map already in state for base currency conversion.
