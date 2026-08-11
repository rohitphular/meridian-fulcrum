# Insights — FE / BE / Job Requirements

## Global Rules

- Job always computes comparison payloads (`compared_with_prev_period`, `compared_with_same_period_last_year`) for every row.
- FE always offers a toggle whenever a comparison column is non-empty — user chooses between merged chart (comparison overlaid) or stat cards only.

## Selected Insights

| # | Insight | What it shows |
|---|---------|---------------|
| 1 | **Category Spend Trend** | Expenses grouped by major category for the selected period, with optional comparison |
| 2 | **Overall Spend Trend** | Total spend over time for the selected period, with optional comparison |
| 3 | **Income, Expense & Savings Rate** | Avg daily income, expenses, and savings rate — 3 lines, with optional comparison |
| 4 | **Net Worth Trend** | Sum of all asset accounts minus liability accounts over time |
| 5 | **Assets Trend** | Total asset account balances over time |
| 6 | **Investments Trend** | Investment account balances over time |
| 7 | **Liabilities Trend** | Total liability account balances over time |
| 8 | **Tag Spend Trend** | Spend grouped by tag for the selected period, with optional comparison |
| 9 | **Debt Paydown Progress** | Outstanding balance on each liability over time |

## Category Spend Trend

| insight_id | chart_type | chart_period | insight_payload | compared_with_prev_period | compared_with_same_period_last_year | description | expert_commentary | computed_at |
|------------|------------|--------------|-----------------|---------------------------|-------------------------------------|-------------|-------------------|-------------|
| category_spend_trend | hbar | last_7_days | | | | | | |
| category_spend_trend | hbar | last_14_days | | | | | | |
| category_spend_trend | hbar | last_30_days | | | | | | |
| category_spend_trend | hbar | last_60_days | | | | | | |
| category_spend_trend | hbar | last_90_days | | | | | | |
| category_spend_trend | hbar | last_180_days | | | | | | |
| category_spend_trend | hbar | last_365_days | | | | | | |
| category_spend_trend | hbar | prev_month | | | | | | |
| category_spend_trend | hbar | prev_quarter | | | | | | |
| category_spend_trend | hbar | prev_year | | | | | | |
| category_spend_trend | hbar | ytd | | | | | | |
| category_spend_trend | pie | last_7_days | | | | | | |
| category_spend_trend | pie | last_14_days | | | | | | |
| category_spend_trend | pie | last_30_days | | | | | | |
| category_spend_trend | pie | last_60_days | | | | | | |
| category_spend_trend | pie | last_90_days | | | | | | |
| category_spend_trend | pie | last_180_days | | | | | | |
| category_spend_trend | pie | last_365_days | | | | | | |
| category_spend_trend | pie | prev_month | | | | | | |
| category_spend_trend | pie | prev_quarter | | | | | | |
| category_spend_trend | pie | prev_year | | | | | | |
| category_spend_trend | pie | ytd | | | | | | |
| category_spend_trend | treemap | last_7_days | | | | | | |
| category_spend_trend | treemap | last_14_days | | | | | | |
| category_spend_trend | treemap | last_30_days | | | | | | |
| category_spend_trend | treemap | last_60_days | | | | | | |
| category_spend_trend | treemap | last_90_days | | | | | | |
| category_spend_trend | treemap | last_180_days | | | | | | |
| category_spend_trend | treemap | last_365_days | | | | | | |
| category_spend_trend | treemap | prev_month | | | | | | |
| category_spend_trend | treemap | prev_quarter | | | | | | |
| category_spend_trend | treemap | prev_year | | | | | | |
| category_spend_trend | treemap | ytd | | | | | | |

## Overall Spend Trend

> Y axis = average spend per day within each time bucket.

| insight_id | chart_type | chart_period | insight_payload | compared_with_prev_period | compared_with_same_period_last_year | description | expert_commentary | computed_at |
|------------|------------|--------------|-----------------|---------------------------|-------------------------------------|-------------|-------------------|-------------|
| overall_spend_trend | line | last_7_days | | | | | | |
| overall_spend_trend | line | last_14_days | | | | | | |
| overall_spend_trend | line | last_30_days | | | | | | |
| overall_spend_trend | line | last_60_days | | | | | | |
| overall_spend_trend | line | last_90_days | | | | | | |
| overall_spend_trend | line | last_180_days | | | | | | |
| overall_spend_trend | line | last_365_days | | | | | | |
| overall_spend_trend | line | prev_month | | | | | | |
| overall_spend_trend | line | prev_quarter | | | | | | |
| overall_spend_trend | line | prev_year | | | | | | |
| overall_spend_trend | line | ytd | | | | | | |
| overall_spend_trend | bar | last_7_days | | | | | | |
| overall_spend_trend | bar | last_14_days | | | | | | |
| overall_spend_trend | bar | last_30_days | | | | | | |
| overall_spend_trend | bar | last_60_days | | | | | | |
| overall_spend_trend | bar | last_90_days | | | | | | |
| overall_spend_trend | bar | last_180_days | | | | | | |
| overall_spend_trend | bar | last_365_days | | | | | | |
| overall_spend_trend | bar | prev_month | | | | | | |
| overall_spend_trend | bar | prev_quarter | | | | | | |
| overall_spend_trend | bar | prev_year | | | | | | |
| overall_spend_trend | bar | ytd | | | | | | |

## Income, Expense & Savings Rate

> Y axis = average per day within each time bucket. 3 datasets: income/day, expense/day, savings rate %.

| insight_id | chart_type | chart_period | insight_payload | compared_with_prev_period | compared_with_same_period_last_year | description | expert_commentary | computed_at |
|------------|------------|--------------|-----------------|---------------------------|-------------------------------------|-------------|-------------------|-------------|
| income_expense_savings_rate | line | last_7_days | | | | | | |
| income_expense_savings_rate | line | last_14_days | | | | | | |
| income_expense_savings_rate | line | last_30_days | | | | | | |
| income_expense_savings_rate | line | last_60_days | | | | | | |
| income_expense_savings_rate | line | last_90_days | | | | | | |
| income_expense_savings_rate | line | last_180_days | | | | | | |
| income_expense_savings_rate | line | last_365_days | | | | | | |
| income_expense_savings_rate | line | prev_month | | | | | | |
| income_expense_savings_rate | line | prev_quarter | | | | | | |
| income_expense_savings_rate | line | prev_year | | | | | | |
| income_expense_savings_rate | line | ytd | | | | | | |
| income_expense_savings_rate | bar | last_7_days | | | | | | |
| income_expense_savings_rate | bar | last_14_days | | | | | | |
| income_expense_savings_rate | bar | last_30_days | | | | | | |
| income_expense_savings_rate | bar | last_60_days | | | | | | |
| income_expense_savings_rate | bar | last_90_days | | | | | | |
| income_expense_savings_rate | bar | last_180_days | | | | | | |
| income_expense_savings_rate | bar | last_365_days | | | | | | |
| income_expense_savings_rate | bar | prev_month | | | | | | |
| income_expense_savings_rate | bar | prev_quarter | | | | | | |
| income_expense_savings_rate | bar | prev_year | | | | | | |
| income_expense_savings_rate | bar | ytd | | | | | | |
| income_expense_savings_rate | stacked | last_7_days | | | | | | |
| income_expense_savings_rate | stacked | last_14_days | | | | | | |
| income_expense_savings_rate | stacked | last_30_days | | | | | | |
| income_expense_savings_rate | stacked | last_60_days | | | | | | |
| income_expense_savings_rate | stacked | last_90_days | | | | | | |
| income_expense_savings_rate | stacked | last_180_days | | | | | | |
| income_expense_savings_rate | stacked | last_365_days | | | | | | |
| income_expense_savings_rate | stacked | prev_month | | | | | | |
| income_expense_savings_rate | stacked | prev_quarter | | | | | | |
| income_expense_savings_rate | stacked | prev_year | | | | | | |
| income_expense_savings_rate | stacked | ytd | | | | | | |

## Net Worth Trend

| insight_id | chart_type | chart_period | insight_payload | compared_with_prev_period | compared_with_same_period_last_year | description | expert_commentary | computed_at |
|------------|------------|--------------|-----------------|---------------------------|-------------------------------------|-------------|-------------------|-------------|
| net_worth_trend | line | last_7_days | | | | | | |
| net_worth_trend | line | last_14_days | | | | | | |
| net_worth_trend | line | last_30_days | | | | | | |
| net_worth_trend | line | last_60_days | | | | | | |
| net_worth_trend | line | last_90_days | | | | | | |
| net_worth_trend | line | last_180_days | | | | | | |
| net_worth_trend | line | last_365_days | | | | | | |
| net_worth_trend | line | prev_month | | | | | | |
| net_worth_trend | line | prev_quarter | | | | | | |
| net_worth_trend | line | prev_year | | | | | | |
| net_worth_trend | line | ytd | | | | | | |
| net_worth_trend | bar | last_7_days | | | | | | |
| net_worth_trend | bar | last_14_days | | | | | | |
| net_worth_trend | bar | last_30_days | | | | | | |
| net_worth_trend | bar | last_60_days | | | | | | |
| net_worth_trend | bar | last_90_days | | | | | | |
| net_worth_trend | bar | last_180_days | | | | | | |
| net_worth_trend | bar | last_365_days | | | | | | |
| net_worth_trend | bar | prev_month | | | | | | |
| net_worth_trend | bar | prev_quarter | | | | | | |
| net_worth_trend | bar | prev_year | | | | | | |
| net_worth_trend | bar | ytd | | | | | | |

## Assets Trend

| insight_id | chart_type | chart_period | insight_payload | compared_with_prev_period | compared_with_same_period_last_year | description | expert_commentary | computed_at |
|------------|------------|--------------|-----------------|---------------------------|-------------------------------------|-------------|-------------------|-------------|
| assets_trend | line | last_7_days | | | | | | |
| assets_trend | line | last_14_days | | | | | | |
| assets_trend | line | last_30_days | | | | | | |
| assets_trend | line | last_60_days | | | | | | |
| assets_trend | line | last_90_days | | | | | | |
| assets_trend | line | last_180_days | | | | | | |
| assets_trend | line | last_365_days | | | | | | |
| assets_trend | line | prev_month | | | | | | |
| assets_trend | line | prev_quarter | | | | | | |
| assets_trend | line | prev_year | | | | | | |
| assets_trend | line | ytd | | | | | | |
| assets_trend | bar | last_7_days | | | | | | |
| assets_trend | bar | last_14_days | | | | | | |
| assets_trend | bar | last_30_days | | | | | | |
| assets_trend | bar | last_60_days | | | | | | |
| assets_trend | bar | last_90_days | | | | | | |
| assets_trend | bar | last_180_days | | | | | | |
| assets_trend | bar | last_365_days | | | | | | |
| assets_trend | bar | prev_month | | | | | | |
| assets_trend | bar | prev_quarter | | | | | | |
| assets_trend | bar | prev_year | | | | | | |
| assets_trend | bar | ytd | | | | | | |

## Investments Trend

| insight_id | chart_type | chart_period | insight_payload | compared_with_prev_period | compared_with_same_period_last_year | description | expert_commentary | computed_at |
|------------|------------|--------------|-----------------|---------------------------|-------------------------------------|-------------|-------------------|-------------|
| investments_trend | line | last_7_days | | | | | | |
| investments_trend | line | last_14_days | | | | | | |
| investments_trend | line | last_30_days | | | | | | |
| investments_trend | line | last_60_days | | | | | | |
| investments_trend | line | last_90_days | | | | | | |
| investments_trend | line | last_180_days | | | | | | |
| investments_trend | line | last_365_days | | | | | | |
| investments_trend | line | prev_month | | | | | | |
| investments_trend | line | prev_quarter | | | | | | |
| investments_trend | line | prev_year | | | | | | |
| investments_trend | line | ytd | | | | | | |
| investments_trend | bar | last_7_days | | | | | | |
| investments_trend | bar | last_14_days | | | | | | |
| investments_trend | bar | last_30_days | | | | | | |
| investments_trend | bar | last_60_days | | | | | | |
| investments_trend | bar | last_90_days | | | | | | |
| investments_trend | bar | last_180_days | | | | | | |
| investments_trend | bar | last_365_days | | | | | | |
| investments_trend | bar | prev_month | | | | | | |
| investments_trend | bar | prev_quarter | | | | | | |
| investments_trend | bar | prev_year | | | | | | |
| investments_trend | bar | ytd | | | | | | |

## Liabilities Trend

| insight_id | chart_type | chart_period | insight_payload | compared_with_prev_period | compared_with_same_period_last_year | description | expert_commentary | computed_at |
|------------|------------|--------------|-----------------|---------------------------|-------------------------------------|-------------|-------------------|-------------|
| liabilities_trend | line | last_7_days | | | | | | |
| liabilities_trend | line | last_14_days | | | | | | |
| liabilities_trend | line | last_30_days | | | | | | |
| liabilities_trend | line | last_60_days | | | | | | |
| liabilities_trend | line | last_90_days | | | | | | |
| liabilities_trend | line | last_180_days | | | | | | |
| liabilities_trend | line | last_365_days | | | | | | |
| liabilities_trend | line | prev_month | | | | | | |
| liabilities_trend | line | prev_quarter | | | | | | |
| liabilities_trend | line | prev_year | | | | | | |
| liabilities_trend | line | ytd | | | | | | |
| liabilities_trend | bar | last_7_days | | | | | | |
| liabilities_trend | bar | last_14_days | | | | | | |
| liabilities_trend | bar | last_30_days | | | | | | |
| liabilities_trend | bar | last_60_days | | | | | | |
| liabilities_trend | bar | last_90_days | | | | | | |
| liabilities_trend | bar | last_180_days | | | | | | |
| liabilities_trend | bar | last_365_days | | | | | | |
| liabilities_trend | bar | prev_month | | | | | | |
| liabilities_trend | bar | prev_quarter | | | | | | |
| liabilities_trend | bar | prev_year | | | | | | |
| liabilities_trend | bar | ytd | | | | | | |

## Tag Spend Trend

| insight_id | chart_type | chart_period | insight_payload | compared_with_prev_period | compared_with_same_period_last_year | description | expert_commentary | computed_at |
|------------|------------|--------------|-----------------|---------------------------|-------------------------------------|-------------|-------------------|-------------|
| tag_spend_trend | line | last_7_days | | | | | | |
| tag_spend_trend | line | last_14_days | | | | | | |
| tag_spend_trend | line | last_30_days | | | | | | |
| tag_spend_trend | line | last_60_days | | | | | | |
| tag_spend_trend | line | last_90_days | | | | | | |
| tag_spend_trend | line | last_180_days | | | | | | |
| tag_spend_trend | line | last_365_days | | | | | | |
| tag_spend_trend | line | prev_month | | | | | | |
| tag_spend_trend | line | prev_quarter | | | | | | |
| tag_spend_trend | line | prev_year | | | | | | |
| tag_spend_trend | line | ytd | | | | | | |
| tag_spend_trend | bar | last_7_days | | | | | | |
| tag_spend_trend | bar | last_14_days | | | | | | |
| tag_spend_trend | bar | last_30_days | | | | | | |
| tag_spend_trend | bar | last_60_days | | | | | | |
| tag_spend_trend | bar | last_90_days | | | | | | |
| tag_spend_trend | bar | last_180_days | | | | | | |
| tag_spend_trend | bar | last_365_days | | | | | | |
| tag_spend_trend | bar | prev_month | | | | | | |
| tag_spend_trend | bar | prev_quarter | | | | | | |
| tag_spend_trend | bar | prev_year | | | | | | |
| tag_spend_trend | bar | ytd | | | | | | |
| tag_spend_trend | pie | last_7_days | | | | | | |
| tag_spend_trend | pie | last_14_days | | | | | | |
| tag_spend_trend | pie | last_30_days | | | | | | |
| tag_spend_trend | pie | last_60_days | | | | | | |
| tag_spend_trend | pie | last_90_days | | | | | | |
| tag_spend_trend | pie | last_180_days | | | | | | |
| tag_spend_trend | pie | last_365_days | | | | | | |
| tag_spend_trend | pie | prev_month | | | | | | |
| tag_spend_trend | pie | prev_quarter | | | | | | |
| tag_spend_trend | pie | prev_year | | | | | | |
| tag_spend_trend | pie | ytd | | | | | | |
| tag_spend_trend | treemap | last_7_days | | | | | | |
| tag_spend_trend | treemap | last_14_days | | | | | | |
| tag_spend_trend | treemap | last_30_days | | | | | | |
| tag_spend_trend | treemap | last_60_days | | | | | | |
| tag_spend_trend | treemap | last_90_days | | | | | | |
| tag_spend_trend | treemap | last_180_days | | | | | | |
| tag_spend_trend | treemap | last_365_days | | | | | | |
| tag_spend_trend | treemap | prev_month | | | | | | |
| tag_spend_trend | treemap | prev_quarter | | | | | | |
| tag_spend_trend | treemap | prev_year | | | | | | |
| tag_spend_trend | treemap | ytd | | | | | | |

## Debt Paydown Progress

| insight_id | chart_type | chart_period | insight_payload | compared_with_prev_period | compared_with_same_period_last_year | description | expert_commentary | computed_at |
|------------|------------|--------------|-----------------|---------------------------|-------------------------------------|-------------|-------------------|-------------|
| debt_paydown_progress | line | last_7_days | | | | | | |
| debt_paydown_progress | line | last_14_days | | | | | | |
| debt_paydown_progress | line | last_30_days | | | | | | |
| debt_paydown_progress | line | last_60_days | | | | | | |
| debt_paydown_progress | line | last_90_days | | | | | | |
| debt_paydown_progress | line | last_180_days | | | | | | |
| debt_paydown_progress | line | last_365_days | | | | | | |
| debt_paydown_progress | line | prev_month | | | | | | |
| debt_paydown_progress | line | prev_quarter | | | | | | |
| debt_paydown_progress | line | prev_year | | | | | | |
| debt_paydown_progress | line | ytd | | | | | | |
| debt_paydown_progress | bar | last_7_days | | | | | | |
| debt_paydown_progress | bar | last_14_days | | | | | | |
| debt_paydown_progress | bar | last_30_days | | | | | | |
| debt_paydown_progress | bar | last_60_days | | | | | | |
| debt_paydown_progress | bar | last_90_days | | | | | | |
| debt_paydown_progress | bar | last_180_days | | | | | | |
| debt_paydown_progress | bar | last_365_days | | | | | | |
| debt_paydown_progress | bar | prev_month | | | | | | |
| debt_paydown_progress | bar | prev_quarter | | | | | | |
| debt_paydown_progress | bar | prev_year | | | | | | |
| debt_paydown_progress | bar | ytd | | | | | | |
