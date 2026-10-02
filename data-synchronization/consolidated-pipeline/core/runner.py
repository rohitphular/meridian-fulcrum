from __future__ import annotations

import argparse
import getpass
import os
import re
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from py_logging import get_logger

import core.config as config
from core.pipeline_config import PipelineConfig, PipelineConfigError, Stage, load
from core.report import RunReport

logger = get_logger(__name__)

# Credential kinds a module can declare from `cicd/check.sh` (credentials=<kind>).
_GAS_PIN_TOTP = "gas-pin-totp"
# Stored credentials for gas-pin-totp, from infrastructure/.env.<env> (same names as the
# GAS Script Properties). When both are set the stages read them themselves.
_PIN_VARIABLE = "MERIDIAN_FULCRUM_PIN"
_SECRET_VARIABLE = "MERIDIAN_FULCRUM_SECRET"


class PipelineError(RuntimeError):
    """The message is a safe code: module names and stage numbers only."""


class _Terminated(BaseException):
    """SIGTERM / SIGHUP (the terminal closed, a scheduler stopped the run)."""


def _on_signal(signum: int, _frame: Any) -> None:
    raise _Terminated(signal.Signals(signum).name.lower())


@dataclass
class StageResult:
    stage: Stage
    status: str = "not run"
    seconds: float = 0.0


def _launcher(stage: Stage, script: str = "start-up.sh") -> Path:
    cicd = config.DATA_SYNC_ROOT / stage.module / "cicd"
    if stage.module == "consolidated-pipeline" or not (cicd / "start-up.sh").is_file() or not (cicd / "check.sh").is_file():
        raise PipelineError(f"unknown_module:stage={stage.number}:{stage.module}")
    return cicd / script


def _stage_environment(credentials: bool = False) -> dict[str, str]:
    """Each stage's launcher uses its own uv project; the pipeline's virtualenv must not leak in.

    Stored credentials reach only the stages whose check.sh declares them.
    """
    dropped = {"VIRTUAL_ENV"} | (set() if credentials else {_PIN_VARIABLE, _SECRET_VARIABLE})
    return {key: value for key, value in os.environ.items() if key not in dropped}


def _command(stage: Stage, config_path: Path, *flags: str, script: str = "start-up.sh") -> list[str]:
    return ["bash", str(_launcher(stage, script)), "--config", str(config_path), "--stage", str(stage.number), *flags]


def preflight(pipeline: PipelineConfig, config_path: Path, report: RunReport | None = None) -> dict[str, list[Stage]]:
    """Runs every stage's cicd/check.sh before any stage starts; returns stages by credential kind.

    Each start-up.sh runs the same check again first, so a stage never starts unchecked.
    """
    for stage in pipeline.stages:
        _launcher(stage)
    needs: dict[str, list[Stage]] = {}
    for stage in pipeline.stages:
        started = time.monotonic()
        checked = subprocess.run(_command(stage, config_path, script="check.sh"), stdin=subprocess.DEVNULL, capture_output=True, text=True, env=_stage_environment())
        if checked.returncode != 0:
            print(checked.stdout + checked.stderr, file=sys.stderr, end="")
            if report is not None:
                lines = [line for line in (checked.stdout + checked.stderr).splitlines() if line.startswith("ERROR")]
                report.preflight(stage, False, time.monotonic() - started, lines[-1] if lines else "")
            raise PipelineError(f"preflight_failed:stage={stage.number}:{stage.module}")
        if report is not None:
            report.preflight(stage, True, time.monotonic() - started)
        for line in checked.stdout.splitlines():
            if line.startswith("credentials="):
                kind = line.removeprefix("credentials=")
                if kind != _GAS_PIN_TOTP:
                    raise PipelineError(f"unsupported_credentials:stage={stage.number}:{stage.module}")
                needs.setdefault(kind, []).append(stage)
        logger.info(f"pipeline: preflight stage={stage.number} module={stage.module} mode={stage.mode} ok=true")
    return needs


def credentials_are_stored() -> bool:
    pin, secret = os.environ.get(_PIN_VARIABLE, ""), os.environ.get(_SECRET_VARIABLE, "")
    if bool(pin) != bool(secret):
        raise PipelineError("incomplete_stored_credentials")
    return bool(pin)


def ask_credentials() -> tuple[str, str]:
    """The only prompt in a pipeline run. The values stay in memory and reach stages on stdin."""
    pin = getpass.getpass("PIN: ")
    code = input("Authenticator code: ").strip()
    if not pin:
        raise PipelineError("pin_required")
    if not re.fullmatch(r"[0-9]{6}", code):
        raise PipelineError("invalid_authenticator_code")
    return pin, code


def sign_in(stage: Stage, config_path: Path, pin: str, code: str, report: RunReport | None = None) -> None:
    """Signs in straight away, while the code is fresh; later stages use the PIN only.

    With stored credentials (pin and code empty) the stage reads them itself; nothing goes on stdin.
    """
    logger.info(f"pipeline: sign_in stage={stage.number} module={stage.module} stored_credentials={not pin}")
    command = _command(stage, config_path, "--sign-in-only")
    started = time.monotonic()
    if pin:
        completed = subprocess.run(command, input=f"{pin}\n{code}\n", text=True, env=_stage_environment(credentials=True))
    else:
        completed = subprocess.run(command, stdin=subprocess.DEVNULL, env=_stage_environment(credentials=True))
    if report is not None:
        report.sign_in(stage, completed.returncode == 0, time.monotonic() - started)
    if completed.returncode != 0:
        raise PipelineError(f"sign_in_failed:stage={stage.number}:{stage.module}")


def _descendants(pid: int) -> list[int]:
    found: list[int] = []
    queue = [pid]
    while queue:
        try:
            listed = subprocess.run(["pgrep", "-P", str(queue.pop())], capture_output=True, text=True, timeout=5).stdout
        except (OSError, subprocess.SubprocessError):
            continue
        children = [int(child) for child in listed.split()]
        found.extend(children)
        queue.extend(children)
    return found


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _stop_stage(process: subprocess.Popen[str], grace_seconds: float = 10.0) -> None:
    """Stops the launcher and everything it started (bash → uv → python).

    Signalling the launcher alone would leave the job running, holding its lock.
    SIGINT first, so a Python job unwinds (the load still stores its outcomes); SIGKILL after the grace period.
    """
    pids = [process.pid, *_descendants(process.pid)]
    for pid in pids:
        try:
            os.kill(pid, signal.SIGINT)
        except (ProcessLookupError, PermissionError):
            pass
    deadline = time.monotonic() + grace_seconds
    while time.monotonic() < deadline and (process.poll() is None or any(_alive(pid) for pid in pids[1:])):
        time.sleep(0.1)
    for pid in pids:
        if _alive(pid):
            try:
                os.kill(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
    process.wait()


def _run_stage(command: list[str], stdin_text: str | None, on_line: Any, credentials: bool = False) -> int:
    """Runs one stage, echoing its output live and handing each line to `on_line`.

    If the pipeline is stopped mid-stage, the stage and its child processes are stopped too.
    """
    process = subprocess.Popen(
        command,
        stdin=subprocess.PIPE if stdin_text is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        env=_stage_environment(credentials),
    )
    try:
        if stdin_text is not None:
            assert process.stdin is not None
            process.stdin.write(stdin_text)
            process.stdin.close()
        assert process.stdout is not None
        for line in process.stdout:
            sys.stdout.write(line)
            sys.stdout.flush()
            on_line(line)
        return process.wait()
    except BaseException:
        if process.poll() is None:
            _stop_stage(process)
        raise


def run_stages(pipeline: PipelineConfig, config_path: Path, credential_stages: set[int], pin: str, report: RunReport | None = None) -> list[StageResult]:
    results = [StageResult(stage) for stage in pipeline.stages]
    failed = False
    for result in results:
        stage = result.stage
        if failed and not stage.run_after_failure:
            continue
        print(f"\n=== Stage {stage.number}/{len(pipeline.stages)}: {stage.module} ({stage.mode}) ===", flush=True)
        started = time.monotonic()
        if report is not None:
            report.stage_started(stage.number)
        on_line = (lambda line, number=stage.number: report.stage_line(number, line)) if report is not None else (lambda line: None)
        if stage.number in credential_stages:
            exit_code = _run_stage(_command(stage, config_path, "--skip-sign-in"), f"{pin}\n" if pin else None, on_line, credentials=True)
        else:
            exit_code = _run_stage(_command(stage, config_path), None, on_line)
        result.seconds = time.monotonic() - started
        result.status = "ok" if exit_code == 0 else f"failed (exit {exit_code})"
        if report is not None:
            report.stage_finished(stage.number, exit_code, result.seconds)
        logger.info(f"pipeline: stage={stage.number} module={stage.module} mode={stage.mode} exit={exit_code} seconds={result.seconds:.1f}")
        if exit_code != 0:
            failed = True
    return results


def print_summary(env: str, results: list[StageResult]) -> None:
    print(f"\nPipeline summary — environment: {env}")
    for result in results:
        print(f"  {result.stage.number}. {result.stage.module:<24} {result.stage.mode:<14} {result.status:<18} {result.seconds:7.1f}s")


def main() -> None:
    parser = argparse.ArgumentParser(description="Run data-synchronization modules in order from one config file")
    parser.add_argument("--config", type=Path, required=True, help="Pipeline config: config/pipeline.<env>.json")
    args = parser.parse_args()
    config_path = args.config.resolve()
    report = RunReport(config.OUTPUT_DATA_DIR, config_path, config.REPOSITORY_ROOT)
    logger.info(f"pipeline: report={report.path.name}")
    for signum in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, _on_signal)
    try:
        _run(config_path, report)
    except _Terminated as stopped:
        logger.error(f"pipeline: failed reason=interrupted signal={stopped}")
        report.finish("interrupted", f"signal:{stopped}")
        sys.exit(1)
    except Exception as error:
        # A pipeline bug must not leave the report "running": record the error type only.
        logger.error(f"pipeline: failed reason=unexpected_error type={type(error).__name__}")
        report.finish("failed", f"unexpected_error:{type(error).__name__}")
        raise
    finally:
        if not report.finished:
            report.finish("failed", "aborted")


def _run(config_path: Path, report: RunReport) -> None:
    try:
        pipeline = load(config_path)
        report.set_pipeline(pipeline.env, pipeline.stages)
        logger.info(f"pipeline: start=true env={pipeline.env} stages={len(pipeline.stages)}")
        needs = preflight(pipeline, config_path, report)
        pin = ""
        credential_stages: set[int] = set()
        if needs:
            stored = credentials_are_stored()
            report.credentials("stored" if stored else "prompted")
            pin, code = ("", "") if stored else ask_credentials()
            stages = needs[_GAS_PIN_TOTP]
            sign_in(stages[0], config_path, pin, code, report)
            credential_stages = {stage.number for stage in stages}
        results = run_stages(pipeline, config_path, credential_stages, pin, report)
    except (PipelineConfigError, PipelineError) as error:
        logger.error(f"pipeline: failed reason={error}")
        report.finish(str(error).split(":", 1)[0] if str(error).startswith(("preflight_failed", "sign_in_failed")) else "failed", str(error))
        sys.exit(1)
    except (KeyboardInterrupt, EOFError):
        logger.error("pipeline: failed reason=interrupted")
        report.finish("interrupted", "interrupted")
        sys.exit(1)
    print_summary(pipeline.env, results)
    failed = [result for result in results if result.status != "ok" and result.status != "not run"]
    if failed:
        reason = f"stage_failed:stage={failed[0].stage.number}:{failed[0].stage.module}"
        logger.error(f"pipeline: failed reason={reason}")
        report.finish("failed", reason)
        sys.exit(1)
    report.finish("ok")
    logger.info("pipeline: complete=true")


if __name__ == "__main__":
    main()
