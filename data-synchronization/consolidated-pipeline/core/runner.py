from __future__ import annotations

import argparse
import getpass
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

from py_logging import get_logger

import core.config as config
from core.pipeline_config import PipelineConfig, PipelineConfigError, Stage, load

logger = get_logger(__name__)

# Credential kinds a module can declare from `cicd/check.sh` (credentials=<kind>).
_GAS_PIN_TOTP = "gas-pin-totp"


class PipelineError(RuntimeError):
    """The message is a safe code: module names and stage numbers only."""


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


def _stage_environment() -> dict[str, str]:
    # Each stage's launcher uses its own uv project; the pipeline's virtualenv must not leak in.
    return {key: value for key, value in os.environ.items() if key != "VIRTUAL_ENV"}


def _command(stage: Stage, config_path: Path, *flags: str, script: str = "start-up.sh") -> list[str]:
    return ["bash", str(_launcher(stage, script)), "--config", str(config_path), "--stage", str(stage.number), *flags]


def preflight(pipeline: PipelineConfig, config_path: Path) -> dict[str, list[Stage]]:
    """Runs every stage's cicd/check.sh before any stage starts; returns stages by credential kind.

    Each start-up.sh runs the same check again first, so a stage never starts unchecked.
    """
    for stage in pipeline.stages:
        _launcher(stage)
    needs: dict[str, list[Stage]] = {}
    for stage in pipeline.stages:
        checked = subprocess.run(_command(stage, config_path, script="check.sh"), stdin=subprocess.DEVNULL, capture_output=True, text=True, env=_stage_environment())
        if checked.returncode != 0:
            print(checked.stdout + checked.stderr, file=sys.stderr, end="")
            raise PipelineError(f"preflight_failed:stage={stage.number}:{stage.module}")
        for line in checked.stdout.splitlines():
            if line.startswith("credentials="):
                kind = line.removeprefix("credentials=")
                if kind != _GAS_PIN_TOTP:
                    raise PipelineError(f"unsupported_credentials:stage={stage.number}:{stage.module}")
                needs.setdefault(kind, []).append(stage)
        logger.info(f"pipeline: preflight stage={stage.number} module={stage.module} mode={stage.mode} ok=true")
    return needs


def ask_credentials() -> tuple[str, str]:
    """The only prompt in a pipeline run. The values stay in memory and reach stages on stdin."""
    pin = getpass.getpass("PIN: ")
    code = input("Authenticator code: ").strip()
    if not pin:
        raise PipelineError("pin_required")
    if not re.fullmatch(r"[0-9]{6}", code):
        raise PipelineError("invalid_authenticator_code")
    return pin, code


def sign_in(stage: Stage, config_path: Path, pin: str, code: str) -> None:
    """Signs in straight away, while the code is fresh; later stages use the PIN only."""
    logger.info(f"pipeline: sign_in stage={stage.number} module={stage.module}")
    if subprocess.run(_command(stage, config_path, "--sign-in-only"), input=f"{pin}\n{code}\n", text=True, env=_stage_environment()).returncode != 0:
        raise PipelineError(f"sign_in_failed:stage={stage.number}:{stage.module}")


def run_stages(pipeline: PipelineConfig, config_path: Path, credential_stages: set[int], pin: str) -> list[StageResult]:
    results = [StageResult(stage) for stage in pipeline.stages]
    for result in results:
        stage = result.stage
        print(f"\n=== Stage {stage.number}/{len(pipeline.stages)}: {stage.module} ({stage.mode}) ===", flush=True)
        started = time.monotonic()
        if stage.number in credential_stages:
            completed = subprocess.run(_command(stage, config_path, "--skip-sign-in"), input=f"{pin}\n", text=True, env=_stage_environment())
        else:
            completed = subprocess.run(_command(stage, config_path), stdin=subprocess.DEVNULL, env=_stage_environment())
        result.seconds = time.monotonic() - started
        result.status = "ok" if completed.returncode == 0 else f"failed (exit {completed.returncode})"
        logger.info(f"pipeline: stage={stage.number} module={stage.module} mode={stage.mode} exit={completed.returncode} seconds={result.seconds:.1f}")
        if completed.returncode != 0:
            break
    return results


def print_summary(env: str, results: list[StageResult]) -> None:
    print(f"\nPipeline summary — environment: {env}")
    for result in results:
        print(f"  {result.stage.number}. {result.stage.module:<24} {result.stage.mode:<14} {result.status:<18} {result.seconds:7.1f}s")


def main() -> None:
    parser = argparse.ArgumentParser(description="Run data-synchronization modules in order from one config file")
    parser.add_argument("--config", type=Path, default=config.DEFAULT_CONFIG, help="Pipeline config (default: consolidated-pipeline/pipeline.json)")
    args = parser.parse_args()
    config_path = args.config.resolve()
    try:
        pipeline = load(config_path)
        logger.info(f"pipeline: start=true env={pipeline.env} stages={len(pipeline.stages)}")
        needs = preflight(pipeline, config_path)
        pin = ""
        credential_stages: set[int] = set()
        if needs:
            pin, code = ask_credentials()
            stages = needs[_GAS_PIN_TOTP]
            sign_in(stages[0], config_path, pin, code)
            credential_stages = {stage.number for stage in stages}
        results = run_stages(pipeline, config_path, credential_stages, pin)
    except (PipelineConfigError, PipelineError) as error:
        logger.error(f"pipeline: failed reason={error}")
        sys.exit(1)
    except (KeyboardInterrupt, EOFError):
        logger.error("pipeline: failed reason=interrupted")
        sys.exit(1)
    print_summary(pipeline.env, results)
    failed = [result for result in results if result.status != "ok"]
    if failed:
        logger.error(f"pipeline: failed reason=stage_failed:stage={failed[0].stage.number}:{failed[0].stage.module}")
        sys.exit(1)
    logger.info("pipeline: complete=true")


if __name__ == "__main__":
    main()
