from jobs.insights.insights.d00_earn_burn_rate import D00EarnBurnRate
from jobs.insights.insights.d01_mom_cumulative import D01MomCumulative
from jobs.insights.insights.d02_yoy_monthly import D02YoyMonthly
from jobs.insights.insights.d03_wow_daily import D03WowDaily
from jobs.insights.insights.d04_qtd_comparison import D04QtdComparison
from jobs.insights.insights.d05_ytd_comparison import D05YtdComparison
from jobs.insights.insights.d06_last_12_months import D06Last12Months
from jobs.insights.insights.d07_last_8_weeks import D07Last8Weeks
from jobs.insights.insights.d08_category_pie import D08CategoryPie
from jobs.insights.insights.d09_category_trend import D09CategoryTrend
from jobs.insights.insights.d10_top_categories import D10TopCategories
from jobs.insights.insights.d11_category_drilldown import D11CategoryDrilldown
from jobs.insights.insights.d12_tag_pie import D12TagPie
from jobs.insights.insights.d13_tag_trend import D13TagTrend
from jobs.insights.insights.d14_networth_trend import D14NetworthTrend
from jobs.insights.insights.d15_account_balances import D15AccountBalances
from jobs.insights.insights.d16_asset_vs_liability import D16AssetVsLiability
from jobs.insights.insights.d17_liability_paydown import D17LiabilityPaydown
from jobs.insights.insights.d19_cashflow_waterfall import D19CashflowWaterfall
from jobs.insights.insights.d20_savings_rate import D20SavingsRate
from jobs.insights.insights.d21_income_sources import D21IncomeSources
from jobs.insights.insights.d22_top_counterparties import D22TopCounterparties
from jobs.insights.insights.d23_recurring_payments import D23RecurringPayments
from jobs.insights.insights.d24_spend_by_country import D24SpendByCountry
from jobs.insights.insights.d25_spend_by_city import D25SpendByCity
from jobs.insights.insights.d26_loan_progress import D26LoanProgress
from jobs.insights.insights.d27_debt_to_income import D27DebtToIncome
from jobs.insights.insights.d28_forex_spend import D28ForexSpend

ALL_INSIGHTS = [
    D00EarnBurnRate,
    D01MomCumulative,
    D02YoyMonthly,
    D03WowDaily,
    D04QtdComparison,
    D05YtdComparison,
    D06Last12Months,
    D07Last8Weeks,
    D08CategoryPie,
    D09CategoryTrend,
    D10TopCategories,
    D11CategoryDrilldown,
    D12TagPie,
    D13TagTrend,
    D14NetworthTrend,
    D15AccountBalances,
    D16AssetVsLiability,
    D17LiabilityPaydown,
    D19CashflowWaterfall,
    D20SavingsRate,
    D21IncomeSources,
    D22TopCounterparties,
    D23RecurringPayments,
    D24SpendByCountry,
    D25SpendByCity,
    D26LoanProgress,
    D27DebtToIncome,
    D28ForexSpend,
]
