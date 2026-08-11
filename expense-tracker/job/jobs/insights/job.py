import json
import time
import traceback
from datetime import datetime, timezone

from jobs.base import BaseJob
from jobs.insights.insights import ALL_INSIGHTS
from jobs.insights.period_utils import resolve_period

HEADERS = [
    'computed_at', 'insight_id', 'period_key',
    'derived_from', 'chart_variant', 'insight_payload', 'expert_commentary',
]


class InsightsJob(BaseJob):
    name        = 'insights'
    description = 'Pre-compute all insights and write to computed_insights sheet'

    def run(self) -> None:
        # ── Load raw data ─────────────────────────────────────────────────────
        raw = {}
        for sheet_name in ('transactions', 'accounts', 'categories', 'rates'):
            sheet_rows = self.sheets.read_sheet(sheet_name)
            raw[sheet_name] = sheet_rows
            print(f'  [insights] read {sheet_name}: {len(sheet_rows)} rows')

        rate_map = {}
        for r in raw['rates']:
            try:
                rate_map[r['currency']] = float(r['rate'])
            except (KeyError, ValueError):
                pass
        print(f'  [insights] rate_map: {len(rate_map)} currencies ({", ".join(sorted(rate_map))})')

        quote_currency = self.config.get('quote_currency', 'GBP')
        now_iso        = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

        # ── Pre-enumerate all combinations ────────────────────────────────────
        # Build the full list upfront so we can show (N/total) progress.
        combos = []
        for InsightClass in ALL_INSIGHTS:
            insight = InsightClass(rate_map, quote_currency)
            for period_key in insight.periods:
                from_date, to_date = resolve_period(period_key)
                for derived in insight.derived_from:
                    for variant in insight.chart_variants:
                        combos.append((insight, period_key, from_date, to_date, derived, variant))

        total = len(combos)
        print(f'  [insights] {len(ALL_INSIGHTS)} insights · {total} combinations')

        # ── Compute ───────────────────────────────────────────────────────────
        rows   = []
        errors = 0

        for i, (insight, period_key, from_date, to_date, derived, variant) in enumerate(combos, 1):
            tag = f'{insight.insight_id}/{period_key}/{derived}' + (f'/{variant}' if variant else '')
            print(f'  [insights] ({i:>3}/{total}) {tag}', end='', flush=True)
            t0 = time.time()
            try:
                payload = insight.compute(raw, from_date, to_date, derived, variant)
                elapsed = time.time() - t0

                stat_count = len(payload.get('stat_cards') or [])
                warn = ' ⚠ no stats' if stat_count == 0 else ''
                print(f' → ok {elapsed:.2f}s, {stat_count} stats{warn}')

                rows.append([
                    now_iso,
                    insight.insight_id,
                    period_key,
                    derived,
                    variant,
                    json.dumps(payload, separators=(',', ':')),
                    '',
                ])
            except Exception as e:
                elapsed = time.time() - t0
                print(f' → SKIP {elapsed:.2f}s: {e}')
                traceback.print_exc()
                errors += 1

        # ── Write ─────────────────────────────────────────────────────────────
        self.sheets.replace_today_and_trim('computed_insights', HEADERS, rows, retain_days=30)
        status = 'OK' if errors == 0 else f'{errors} SKIPPED'
        print(f'  [insights] wrote {len(rows)}/{total} rows · {status}')
