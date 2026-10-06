"""Pipeline config: validation shared by the pipeline runner and every module launcher.

Standard library only: module launchers run cicd/read-stage.py with the system python3
before their own dependencies are installed.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_NAME = re.compile(r"[a-z][a-z0-9-]*")
# One config per environment: config/pipeline.<env>.json (pipeline.example.json is the template).
_FILE_NAME = re.compile(r"pipeline\.([a-z][a-z0-9-]*)\.json")
TEMPLATE_NAME = "pipeline.example.json"
_TOP_KEYS = {"_comment", "env", "stages"}
_STAGE_KEYS = {"_comment", "module", "mode", "confirm", "run_after_failure"}


class PipelineConfigError(ValueError):
    """The message is a safe code, e.g. 'stage_2_invalid_mode'."""


@dataclass(frozen=True)
class Stage:
    number: int
    module: str
    mode: str
    confirm: str = ""
    # Run this stage even when an earlier stage failed (e.g. acknowledging a partly failed load).
    run_after_failure: bool = False


@dataclass(frozen=True)
class PipelineConfig:
    env: str
    stages: list[Stage]


def _name(value: Any, code: str) -> str:
    if not isinstance(value, str) or not _NAME.fullmatch(value):
        raise PipelineConfigError(code)
    return value


def parse(settings: Any) -> PipelineConfig:
    if not isinstance(settings, dict):
        raise PipelineConfigError("config_not_an_object")
    if set(settings) - _TOP_KEYS:
        raise PipelineConfigError("unknown_config_key")
    env = _name(settings.get("env"), "invalid_env")
    raw_stages = settings.get("stages")
    if not isinstance(raw_stages, list) or not raw_stages:
        raise PipelineConfigError("stages_required")
    stages = []
    for number, raw in enumerate(raw_stages, start=1):
        if not isinstance(raw, dict) or set(raw) - _STAGE_KEYS:
            raise PipelineConfigError(f"stage_{number}_invalid")
        module = _name(raw.get("module"), f"stage_{number}_invalid_module")
        mode = _name(raw.get("mode"), f"stage_{number}_invalid_mode")
        confirm = _name(raw["confirm"], f"stage_{number}_invalid_confirm") if "confirm" in raw else ""
        run_after_failure = raw.get("run_after_failure", False)
        if not isinstance(run_after_failure, bool):
            raise PipelineConfigError(f"stage_{number}_invalid_run_after_failure")
        stages.append(Stage(number, module, mode, confirm, run_after_failure))
    return PipelineConfig(env, stages)


def env_from_file_name(path: Path) -> str:
    match = _FILE_NAME.fullmatch(path.name)
    if not match or path.name == TEMPLATE_NAME:
        raise PipelineConfigError("config_file_name_must_be_pipeline.<env>.json")
    return match.group(1)


def available_envs(config_dir: Path) -> list[str]:
    """Environments with a config file in the folder, sorted; the template is not one."""
    envs = []
    for path in sorted(config_dir.glob("pipeline.*.json")):
        match = _FILE_NAME.fullmatch(path.name)
        if match and path.name != TEMPLATE_NAME and path.is_file():
            envs.append(match.group(1))
    return envs


def load(path: Path) -> PipelineConfig:
    """Loads config/pipeline.<env>.json; its "env" must match the env in the file name."""
    file_env = env_from_file_name(path)
    if not path.is_file():
        raise PipelineConfigError("config_not_found")
    try:
        settings = json.loads(path.read_text())
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise PipelineConfigError("config_not_valid_json") from None
    pipeline = parse(settings)
    if pipeline.env != file_env:
        raise PipelineConfigError("env_does_not_match_file_name")
    return pipeline


def stage_for(config: PipelineConfig, module: str, stage_number: str = "") -> Stage:
    """The module's stage: the numbered one (must belong to the module), else its only stage."""
    if stage_number:
        if not stage_number.isdigit() or not 1 <= int(stage_number) <= len(config.stages):
            raise PipelineConfigError("stage_out_of_range")
        stage = config.stages[int(stage_number) - 1]
        if stage.module != module:
            raise PipelineConfigError("stage_module_mismatch")
        return stage
    matches = [stage for stage in config.stages if stage.module == module]
    if not matches:
        raise PipelineConfigError("module_not_in_pipeline")
    if len(matches) > 1:
        raise PipelineConfigError("module_in_several_stages_pass_stage")
    return matches[0]
