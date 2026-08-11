from jobs.base import BaseJob


class KpiSummaryJob(BaseJob):
    name        = 'kpi_summary'
    description = 'Compute top-level KPIs (income, expense, savings) across standard periods'

    def run(self) -> None:
        print(f"  [{self.name}] placeholder — implementation coming soon")
