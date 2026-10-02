# consolidated-pipeline

Runs data-synchronization modules one after another from one config file, unattended. It holds no data logic: each stage is a module's own `cicd/start-up.sh`, so a module behaves the same whether the pipeline, a scheduler or `make data-sync` starts it. Adding a module to the pipeline only needs a stage in the config.

## Config

One file per environment in `config/`: `config/pipeline.<env>.json` (for example `pipeline.dev.json`, `pipeline.prod.json`). These are **gitignored** (per machine); only the template `config/pipeline.example.json` is committed. Each file adds its env to the menu, so a new environment needs no code change:

```bash
cp data-synchronization/consolidated-pipeline/config/pipeline.example.json data-synchronization/consolidated-pipeline/config/pipeline.dev.json
```

```json
{
  "env": "dev",
  "stages": [
    { "module": "ledger-sheet-load", "mode": "sheet-sync" },
    { "module": "ledger-sheet-extract", "mode": "extract" },
    { "module": "forex-database-load", "mode": "daily" },
    { "module": "ledger-database-load", "mode": "normal-sync" },
    { "module": "ledger-sheet-extract", "mode": "acknowledge", "run_after_failure": true }
  ]
}
```

| Key | Meaning |
|---|---|
| `env` | One environment for every stage; must equal the `<env>` in the file name (a `pipeline.prod.json` that says `dev` is rejected). Each module validates it against its own `cicd/envs.json` |
| `stages[].module` | A folder under `data-synchronization/` with `cicd/check.sh` and `cicd/start-up.sh` |
| `stages[].mode` | That module's mode: forex-database-load `daily`/`historical`; ledger-sheet-load `sheet-sync`/`sheet-rebuild`; ledger-sheet-extract `extract`/`acknowledge`; ledger-database-load `normal-sync`/`hard-sync` |
| `stages[].confirm` | ledger-sheet-load `sheet-rebuild` only: the env name, standing in for typing it |
| `stages[].run_after_failure` | `true` to run this stage even after an earlier stage failed (the acknowledge stage, so a partly failed load still reports its outcomes). Later stages without it are skipped |

Names are lowercase letters, digits and hyphens. Unknown keys are rejected. A module may appear in several stages.

## What a run does

1. **Preflight**: runs every stage's `cicd/check.sh`, which validates env, mode and the module's own settings without installing, migrating or writing anything. Any failure stops the run before a stage starts. The check is mandatory, not an option: each stage's `start-up.sh` runs the same check again first.
2. **Credentials**: if a stage declares them (ledger-sheet-load prints `credentials=gas-pin-totp`), they come from `MERIDIAN_FULCRUM_PIN` and `MERIDIAN_FULCRUM_SECRET` in `infrastructure/.env.<env>` when both are set (the stage generates the current code from the secret; nothing is asked). Otherwise the pipeline asks once for the PIN and authenticator code, the only prompt. One set without the other fails with `incomplete_stored_credentials`.
3. **Sign in**: straight away, while the code is fresh (it is accepted for about a minute): `start-up.sh --sign-in-only`, with the typed PIN and code on stdin. With stored credentials nothing goes on stdin (it is `/dev/null`); the stage reads them itself. A wrong PIN or code stops the run before any stage starts. Repeated wrong PINs lock the caller, so the pipeline never retries.
4. **Stages**, in order. A stage that needs credentials runs with `--skip-sign-in` and gets only the typed PIN on stdin (nothing with stored credentials); the backend checks the PIN on every call, as it does for the app after login. Other stages and every preflight `check.sh` get no stdin, so nothing can wait for input, and neither `MERIDIAN_FULCRUM_PIN` nor `MERIDIAN_FULCRUM_SECRET`: only stages that declare `credentials=gas-pin-totp` receive them (forex-database-load, ledger-sheet-extract and ledger-database-load also unset them after loading the env file).
5. **Stop at the first failure** (stages with `run_after_failure` still run) and print a summary (stage, module, mode, result, seconds). The exit status is 0 only when every stage succeeded.
6. **Stopped runs**: every launcher (preflight, sign-in, stages) runs in its own session, so Ctrl-C, SIGTERM or SIGHUP (the terminal closed) reach the pipeline only. The pipeline then stops the running launcher and everything it started: one SIGINT to the leaf processes (the job), then SIGKILL to the launcher's process group after up to 10 s. Only the leaves get the SIGINT because `uv run` forwards it; signalling every process would interrupt the job twice and cut short its clean-up. Further signals are ignored while the run shuts down and while the report is written. The report becomes `interrupted` with reason `interrupted` (Ctrl-C, or end of input at the PIN prompt) or `signal:sigterm` / `signal:sighup`. An unexpected pipeline error marks it `failed` with reason `unexpected_error:<Type>`, so a report never stays `running`.

Each module launcher ends with `exec uv run …`, so a signal sent straight to a launcher (kill, a scheduler) reaches the job itself.

The PIN and code never appear in arguments, the pipeline config or logs; typed ones travel on stdin only, stored ones stay in the env file and the processes that load it. The pipeline logs under `$MERIDIAN_LOG_ROOT/consolidated-pipeline/`; each stage logs under its own module folder.

## Monitor

Every run writes a report to `output/data/dd-mm-yyyy-hh-mm-ss.json` (local start time; gitignored), rewritten after each stage and every couple of seconds while a stage runs. `output/index.html` reads that folder and shows:

- **Runs by month → date → batch** (`hh-mm-ss`), with a status dot and a per-stage strip; filters for all / ok / failed / running.
- **Headline numbers:** success rate, latest run, median duration, runs and failures in the last 7 days, rows loaded by the last finished run.
- **The selected run:** status and failure reason, environment, config, credentials mode (stored or prompted — never the values), host, code version; the stage flow; a timeline; preflight and sign-in results.
- **Each stage:** its launcher steps, warnings and errors, the last log lines, and what it did — files loaded into the Sheet, tabs staged, currency series downloaded, entities loaded into PostgreSQL (processed / succeeded / failed / skipped), outcomes written back (written / edited mid-run / not found).
- **Trends:** duration of the last 40 runs coloured by result, and the average time per stage.

Reload every 1, 2, 3, 5, 10, 15 or 30 seconds (or off); **Follow latest** keeps the newest run selected. The page finds the reports through `output/data/index.json`, a list of report files the pipeline rewrites at the start and end of each run, so any static server works — `make app-start` (then `http://localhost:8000/data-synchronization/consolidated-pipeline/output/`) or an IDE's built-in server. It only falls back to a folder listing when the list is missing. Opening the file directly (`file://`) does not work: browsers block reading local files from a page.

Only structured log lines (codes, names and counts) and the launchers' step lines are stored; free-form output such as a printed failed response is not.

Reports and the list are written to a temporary `.<name>.<pid>.tmp` file and then renamed. A run killed in between leaves that file behind; leftovers older than an hour are removed whenever the list is rewritten.

## How to run

```bash
make consolidated-pipeline                          # asks for the env once, then make infra-up, then the pipeline
make consolidated-pipeline ENV=prod                 # no question: infra-up for prod, then config/pipeline.prod.json
make consolidated-pipeline CONFIG=path/pipeline.dev.json   # a file elsewhere (its env is used for infra-up); relative to where you run make
```

From the repository root the target always runs `make infra-up` for the same env first (it is safe to repeat: an existing network and a running PostgreSQL are left as they are), and stops if that fails. The env list comes from `infrastructure/envs.json`; the chosen env must also have a `config/pipeline.<env>.json`.

From this directory: `make run [ENV=...|CONFIG=...]`, or `bash cicd/start-up.sh [--env NAME | --config FILE]`. Any `--config` file must still be named `pipeline.<env>.json`.

A single module can also run unattended from a config: `bash data-synchronization/<module>/cicd/start-up.sh --config FILE [--stage N]` (without `--stage`, the module must appear in exactly one stage).

## Layout

```
consolidated-pipeline/
├── Makefile
├── output/
│   ├── index.html            # monitor page
│   └── data/                 # run reports, gitignored
├── config/
│   ├── pipeline.example.json # committed template
│   └── pipeline.<env>.json   # one per env, gitignored (pipeline.dev.json, pipeline.prod.json, …)
├── pyproject.toml / uv.lock
├── cicd/
│   ├── start-up.sh           # resolves the config, loads the log root, runs core.runner
│   └── read-stage.py         # used by every module launcher to read its stage (system python3)
├── core/
│   ├── config.py             # paths and log root
│   ├── pipeline_config.py    # config validation, shared with read-stage.py (standard library only)
│   ├── report.py             # the run report written for output/index.html
│   └── runner.py             # preflight, sign-in, stages, summary
└── tests/unit/
```

## Development

```bash
make lint
make test-unit
```

Tests use stand-in module launchers that record their arguments and stdin, so they check order, stop-on-failure and that credentials only travel on stdin.
