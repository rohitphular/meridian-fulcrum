# consolidated-pipeline review checklist

Read the [README](../README.md), the module launchers (`codebase/data-synchronization/*/cicd/start-up.sh`) and the standards `APP-BE-PYTHON.md`, `APP-CICD-BE-PYTHON.md`, `APP-LOGGING-PATTERNS.md` and `APP-AUTH-PIN-TOTP.md`.

## Highest-risk checks

- Typed PIN and code reach stages on stdin only; stored ones come only from `MERIDIAN_FULCRUM_PIN` / `MERIDIAN_FULCRUM_SECRET` in the env file. Never in arguments, the config or a log line. With stored credentials nothing goes on stdin. Stages without credentials get no stdin.
- `MERIDIAN_FULCRUM_PIN` / `MERIDIAN_FULCRUM_SECRET` are stripped from the environment of preflight `check.sh` runs and of every stage that does not declare `credentials=gas-pin-totp`.
- Every stage passes its `cicd/check.sh` before any stage runs (and `start-up.sh` always repeats it), and a failed sign-in runs nothing. The pipeline never retries a sign-in.
- The run stops at the first failed stage (except stages with `"run_after_failure": true`, i.e. acknowledge) and exits non-zero; the summary shows which stages ran.
- Config values are validated as plain names before they reach a command line; unknown keys and modules are rejected. `consolidated-pipeline` itself cannot be a stage.
- `config/pipeline.<env>.json` files stay gitignored; `config/pipeline.example.json` stays tracked and valid. The env inside a config must match its file name.
- `core/pipeline_config.py` stays standard-library only: module launchers run `cicd/read-stage.py` with the system python3 before installing anything.
- Stages do not inherit the pipeline's `VIRTUAL_ENV`.
- Every launcher (preflight, sign-in, stage) starts in its own session. A stop sends exactly one SIGINT, to the leaf processes (the job), then SIGKILL to the launcher's process group after 10 s. Never signal the pipeline's own group.
- A report never stays `running`: every exit path (stage failure, Ctrl-C, SIGTERM/SIGHUP, unexpected error) writes a final status, with stop signals ignored while it is written.
- Every module launcher `exec`s its final `uv run`, so a signal sent to the launcher reaches the job.

## Verification

```bash
make lint
make test-unit
```
