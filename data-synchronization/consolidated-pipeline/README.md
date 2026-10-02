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
    { "module": "currency-database-load", "mode": "daily" },
    { "module": "ledger-sheet-extract", "mode": "normal-sync" }
  ]
}
```

| Key | Meaning |
|---|---|
| `env` | One environment for every stage; must equal the `<env>` in the file name (a `pipeline.prod.json` that says `dev` is rejected). Each module validates it against its own `cicd/envs.json` |
| `stages[].module` | A folder under `data-synchronization/` with `cicd/check.sh` and `cicd/start-up.sh` |
| `stages[].mode` | That module's mode: currency-database-load `daily`/`historical`; ledger-sheet-load `sheet-sync`/`sheet-rebuild`; ledger-sheet-extract `normal-sync`/`hard-sync` |
| `stages[].confirm` | ledger-sheet-load `sheet-rebuild` only: the env name, standing in for typing it |

Names are lowercase letters, digits and hyphens. Unknown keys are rejected. A module may appear in several stages.

## What a run does

1. **Preflight**: runs every stage's `cicd/check.sh`, which validates env, mode and the module's own settings without installing, migrating or writing anything. Any failure stops the run before a stage starts. The check is mandatory, not an option: each stage's `start-up.sh` runs the same check again first.
2. **Credentials**: if a stage declares them (ledger-sheet-load prints `credentials=gas-pin-totp`), they come from `MERIDIAN_FULCRUM_PIN` and `MERIDIAN_FULCRUM_SECRET` in `infrastructure/.env.<env>` when both are set (the stage generates the current code from the secret; nothing is asked). Otherwise the pipeline asks once for the PIN and authenticator code, the only prompt. One set without the other fails with `incomplete_stored_credentials`.
3. **Sign in**: straight away, while the code is fresh (it is accepted for about a minute): `start-up.sh --sign-in-only`, with the PIN and code on stdin. A wrong PIN or code stops the run before any stage starts. Repeated wrong PINs lock the caller, so the pipeline never retries.
4. **Stages**, in order. A stage that needs credentials runs with `--skip-sign-in` and gets only the PIN on stdin; the backend checks the PIN on every call, as it does for the app after login. Other stages get no stdin, so nothing can wait for input.
5. **Stop at the first failure** and print a summary (stage, module, mode, result, seconds). The exit status is 0 only when every stage succeeded.

The PIN and code never appear in arguments, the pipeline config or logs; typed ones travel on stdin only, stored ones stay in the env file and the processes that load it. The pipeline logs under `$MERIDIAN_LOG_ROOT/consolidated-pipeline/`; each stage logs under its own module folder.

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
│   └── runner.py             # preflight, sign-in, stages, summary
└── tests/unit/
```

## Development

```bash
make lint
make test-unit
```

Tests use stand-in module launchers that record their arguments and stdin, so they check order, stop-on-failure and that credentials only travel on stdin.
