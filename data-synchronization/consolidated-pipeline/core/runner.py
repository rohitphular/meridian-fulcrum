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


_STOP_SIGNALS = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)


def _ignore_stop_signals() -> None:
    for signum in _STOP_SIGNALS:
        signal.signal(signum, signal.SIG_IGN)


def _on_signal(signum: int, _frame: Any) -> None:
    """The first stop signal wins; later ones are ignored while the run shuts down.

    One Ctrl-C usually arrives twice (from the terminal and forwarded by `uv run`),
    so the handler ignores further signals before it raises.
    """
    _ignore_stop_signals()
    if signum == signal.SIGINT:
        raise KeyboardInterrupt
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
        returncode, output = _run_process(_command(stage, config_path, script="check.sh"), None, capture=True)
        if returncode != 0:
            print(output, file=sys.stderr, end="")
            if report is not None:
                lines = [line for line in output.splitlines() if line.startswith("ERROR")]
                report.preflight(stage, False, time.monotonic() - started, lines[-1] if lines else "")
            raise PipelineError(f"preflight_failed:stage={stage.number}:{stage.module}")
        if report is not None:
            report.preflight(stage, True, time.monotonic() - started)
        for line in output.splitlines():
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
    returncode, _ = _run_process(command, f"{pin}\n{code}\n" if pin else None, credentials=True)
    if report is not None:
        report.sign_in(stage, returncode == 0, time.monotonic() - started)
    if returncode != 0:
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


def _group_alive(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _stop_stage(process: subprocess.Popen[str], grace_seconds: float = 10.0) -> None:
    """Stops a launcher and everything it started (bash → uv → python), in its own session.

    The job gets exactly one SIGINT, sent to the leaves of the process tree: `uv` forwards
    SIGINT to its child, so signalling every process would interrupt the job twice and cut
    short its clean-up (the load storing its outcomes). Whatever is left after the grace
    period is killed, by process group, which also reaches processes whose parent has exited.
    """
    pgid = process.pid  # start_new_session: the launcher leads its own process group
    if process.poll() is None and os.getpgid(pgid) != pgid:
        raise ValueError("stage_not_in_own_session")  # never signal the pipeline's own group
    tree = [process.pid, *_descendants(process.pid)]
    leaves = [pid for pid in tree if not _descendants(pid)] or [process.pid]
    for pid in leaves:
        try:
            os.kill(pid, signal.SIGINT)
        except (ProcessLookupError, PermissionError):
            pass
    deadline = time.monotonic() + grace_seconds
    # poll() reaps the launcher: an exited but unreaped launcher still counts as a group member.
    while time.monotonic() < deadline and (process.poll() is None or _group_alive(pgid)):
        time.sleep(0.1)
    try:
        os.killpg(pgid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    process.wait()


def _run_process(command: list[str], stdin_text: str | None, *, credentials: bool = False, capture: bool = False, on_line: Any = None) -> tuple[int, str]:
    """Runs a launcher in its own session, so only the pipeline decides how it stops.

    A closed terminal or Ctrl-C reaches the pipeline, which stops the launcher's whole
    tree (`_stop_stage`); nothing in a stage reads the terminal (typed credentials arrive
    on stdin). With `on_line` (or `capture`) the output is read line by line.
    """
    piped = capture or on_line is not None
    process = subprocess.Popen(
        command,
        stdin=subprocess.PIPE if stdin_text is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE if piped else None,
        stderr=subprocess.STDOUT if piped else None,
        text=True,
        bufsize=1,
        env=_stage_environment(credentials),
        start_new_session=True,
    )
    lines: list[str] = []
    try:
        if stdin_text is not None:
            assert process.stdin is not None
            process.stdin.write(stdin_text)
            process.stdin.close()
        if piped:
            assert process.stdout is not None
            for line in process.stdout:
                if capture:
                    lines.append(line)
                else:
                    sys.stdout.write(line)
                    sys.stdout.flush()
                    on_line(line)
        return process.wait(), "".join(lines)
    except BaseException:
        # Stop the tree even when the launcher itself has already exited: its children may not have.
        _ignore_stop_signals()
        _stop_stage(process)
        raise


def _run_stage(command: list[str], stdin_text: str | None, on_line: Any, credentials: bool = False) -> int:
    """Runs one stage, echoing its output live and handing each line to `on_line`.

    If the pipeline is stopped mid-stage, the stage and its child processes are stopped too.
    """
    return _run_process(command, stdin_text, credentials=credentials, on_line=on_line)[0]


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
    previous = {signum: signal.getsignal(signum) for signum in _STOP_SIGNALS}
    # Deferred, not lost, until the report exists and the handlers are in place.
    signal.pthread_sigmask(signal.SIG_BLOCK, _STOP_SIGNALS)
    try:
        report = RunReport(config.OUTPUT_DATA_DIR, config_path, config.REPOSITORY_ROOT)
        for signum in _STOP_SIGNALS:
            signal.signal(signum, _on_signal)
    except BaseException:
        signal.pthread_sigmask(signal.SIG_UNBLOCK, _STOP_SIGNALS)
        raise
    try:
        try:
            # A signal deferred while the report was created is delivered here, inside the handling.
            signal.pthread_sigmask(signal.SIG_UNBLOCK, _STOP_SIGNALS)
            outcome = _outcome(config_path, report)
        except _Terminated as stopped:  # before the run started, or between the run and the finish
            outcome = ("interrupted", f"signal:{stopped}", None)
        except KeyboardInterrupt:
            outcome = ("interrupted", "interrupted", None)
        _finish(report, *outcome)
    finally:
        # Last resort: the report must never stay "running" on disk.
        if not report.finished:
            _ignore_stop_signals()
            report.finish("failed", "aborted")
        for signum, handler in previous.items():
            signal.signal(signum, handler)


def _outcome(config_path: Path, report: RunReport) -> tuple[str, str, BaseException | None]:
    """Runs the pipeline; returns (status, reason, unexpected error to re-raise)."""
    logger.info(f"pipeline: report={report.path.name}")
    try:
        return (*_run(config_path, report), None)
    except (PipelineConfigError, PipelineError) as error:
        reason = str(error)
        return (reason.split(":", 1)[0] if reason.startswith(("preflight_failed", "sign_in_failed")) else "failed"), reason, None
    except _Terminated as stopped:
        return "interrupted", f"signal:{stopped}", None
    except (KeyboardInterrupt, EOFError):
        return "interrupted", "interrupted", None
    except Exception as error:
        # A pipeline bug must not leave the report "running": record the error type only.
        return "failed", f"unexpected_error:{type(error).__name__}", error


def _finish(report: RunReport, status: str, reason: str, unexpected: BaseException | None) -> None:
    _ignore_stop_signals()  # the report must reach disk; the run is over either way
    if status == "ok":
        logger.info("pipeline: complete=true")
    else:
        logger.error(f"pipeline: failed reason={reason}")
    report.finish(status, reason)
    if unexpected is not None:
        raise unexpected
    if status != "ok":
        sys.exit(1)


def _run(config_path: Path, report: RunReport) -> tuple[str, str]:
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
    print_summary(pipeline.env, results)
    failed = [result for result in results if result.status != "ok" and result.status != "not run"]
    if failed:
        return "failed", f"stage_failed:stage={failed[0].stage.number}:{failed[0].stage.module}"
    return "ok", ""


if __name__ == "__main__":
    main()
