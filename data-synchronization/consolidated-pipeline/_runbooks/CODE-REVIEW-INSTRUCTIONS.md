# consolidated-pipeline review checklist

Read the [README](../README.md), the module launchers (`data-synchronization/*/cicd/start-up.sh`) and the standards `APP-BE-PYTHON.md`, `APP-CICD-BE-PYTHON.md`, `APP-LOGGING-PATTERNS.md` and `APP-AUTH-PIN-TOTP.md`.

## Highest-risk checks

- Typed PIN and code reach stages on stdin only; stored ones come only from `MERIDIAN_FULCRUM_PIN` / `MERIDIAN_FULCRUM_SECRET` in the env file. Never in arguments, the config or a log line. Stages without credentials get no stdin.
- Every stage passes its `cicd/check.sh` before any stage runs (and `start-up.sh` always repeats it), and a failed sign-in runs nothing. The pipeline never retries a sign-in.
- The run stops at the first failed stage and exits non-zero; the summary shows which stages ran.
- Config values are validated as plain names before they reach a command line; unknown keys and modules are rejected. `pipeline` itself cannot be a stage.
- `config/pipeline.<env>.json` files stay gitignored; `config/pipeline.example.json` stays tracked and valid. The env inside a config must match its file name.
- `core/pipeline_config.py` stays standard-library only: module launchers run `cicd/read-stage.py` with the system python3 before installing anything.
- Stages do not inherit the pipeline's `VIRTUAL_ENV`.

## Verification

```bash
make lint
make test-unit
```
