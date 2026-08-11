#!/usr/bin/env python3
import argparse
import sys
import time
import traceback

import config
from jobs import ALL_JOBS
from sheets_client import SheetsClient


def main():
    parser = argparse.ArgumentParser(description='Forge job processor')
    parser.add_argument('--env', choices=['dev', 'prod'], default='dev',
                        help='Environment to run against (default: dev)')
    parser.add_argument('--job', default=None,
                        help='Run a single job by name (default: run all)')
    args = parser.parse_args()

    print(f"[runner] env={args.env} job={args.job or 'all'}")

    cfg    = config.load(args.env)
    sheets = SheetsClient(cfg['service_account'], cfg['spreadsheet_id'])

    jobs_to_run = ALL_JOBS
    if args.job:
        jobs_to_run = [j for j in ALL_JOBS if j.name == args.job]
        if not jobs_to_run:
            names = ', '.join(j.name for j in ALL_JOBS)
            print(f"[runner] ERROR: unknown job {args.job!r}. Available: {names}")
            sys.exit(1)

    total   = len(jobs_to_run)
    success = 0

    for i, JobClass in enumerate(jobs_to_run, 1):
        job = JobClass(sheets, cfg)
        print(f"\n[runner] ({i}/{total}) {job.name} — {job.description}")
        t0 = time.time()
        try:
            job.run()
            elapsed = time.time() - t0
            print(f"  [{job.name}] done in {elapsed:.2f}s")
            success += 1
        except Exception as e:
            print(f"  [{job.name}] FAILED: {e}")
            traceback.print_exc()

    print(f"\n[runner] finished {success}/{total} jobs")
    if success < total:
        sys.exit(1)


if __name__ == '__main__':
    main()
