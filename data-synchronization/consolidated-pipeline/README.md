# consolidated-pipeline

Runs data-synchronization modules one after another from one config file, unattended. It holds no data logic: each stage is a module's own `cicd/start-up.sh`, so a module behaves the same whether the pipeline, a scheduler or `make data-sync` starts it. Adding a module to the pipeline only needs a stage in the config.

## Config

`pipeline.json` sits in this folder and is **gitignored** (it is per machine). Start from the committed example:

```bash
cp data-synchronization/consolidated-pipeline/pipeline.example.json data-synchronization/consolidated-pipeline/pipeline.json
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
| `env` | One environment for every stage (`dev`, `prod`); each module validates it against its own `cicd/envs.json` |
| `stages[].module` | A folder under `data-synchronization/` with `cicd/check.sh` and `cicd/start-up.sh` |
| `stages[].mode` | That module's mode: currency-database-load `daily`/`historical`; ledger-sheet-load `sheet-sync`/`sheet-rebuild`; ledger-sheet-extract `normal-sync`/`hard-sync` |
| `stages[].confirm` | ledger-sheet-load `sheet-rebuild` only: the env name, standing in for typing it |

Names are lowercase letters, digits and hyphens. Unknown keys are rejected. A module may appear in several stages.

## What a run does

1. **Preflight**: runs every stage's `cicd/check.sh`, which validates env, mode and the module's own settings without installing, migrating or writing anything. Any failure stops the run before a stage starts. The check is mandatory, not an option: each stage's `start-up.sh` runs the same check again first.
2. **Credentials**: if a stage declares them (ledger-sheet-load prints `credentials=gas-pin-totp`), the pipeline asks once for the PIN and authenticator code. This is the only prompt.
3. **Sign in**: straight away, while the code is fresh (it is accepted for about a minute): `start-up.sh --sign-in-only`, with the PIN and code on stdin. A wrong PIN or code stops the run before any stage starts. Repeated wrong PINs lock the caller, so the pipeline never retries.
4. **Stages**, in order. A stage that needs credentials runs with `--skip-sign-in` and gets only the PIN on stdin; the backend checks the PIN on every call, as it does for the app after login. Other stages get no stdin, so nothing can wait for input.
5. **Stop at the first failure** and print a summary (stage, module, mode, result, seconds). The exit status is 0 only when every stage succeeded.

The PIN and code never appear in arguments, environment variables, config or logs. The pipeline logs under `$MERIDIAN_LOG_ROOT/consolidated-pipeline/`; each stage logs under its own module folder.

## How to run

```bash
make consolidated-pipeline                          # from the repository root: consolidated-pipeline/pipeline.json
make consolidated-pipeline CONFIG=nightly.json      # another config; relative to where you run make
```

From this directory: `make run [CONFIG=...]`, or `bash cicd/start-up.sh [--config FILE]`.

A single module can also run unattended from the config: `bash data-synchronization/<module>/cicd/start-up.sh [--config FILE] [--stage N]` (without `--stage`, the module must appear in exactly one stage).

## Layout

```
consolidated-pipeline/
├── Makefile
├── pipeline.example.json     # committed; copy to pipeline.json (gitignored)
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
