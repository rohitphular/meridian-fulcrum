import json
import subprocess
import sys
from pathlib import Path

import pytest

from core.pipeline_config import PipelineConfigError, Stage, available_envs, load, parse, stage_for

READ_STAGE = Path(__file__).resolve().parents[2] / "cicd" / "read-stage.py"
_VALID = {"env": "dev", "stages": [{"module": "a-mod", "mode": "daily"}, {"module": "b-mod", "mode": "sheet-rebuild", "confirm": "dev"}]}


def test_parse_returns_numbered_stages() -> None:
    pipeline = parse(_VALID)
    assert pipeline.env == "dev"
    assert pipeline.stages == [Stage(1, "a-mod", "daily"), Stage(2, "b-mod", "sheet-rebuild", "dev")]


@pytest.mark.parametrize(
    "settings,code",
    [
        ([], "config_not_an_object"),
        ({**_VALID, "extra": 1}, "unknown_config_key"),
        ({**_VALID, "env": "Dev"}, "invalid_env"),
        ({**_VALID, "env": "dev; rm -rf /"}, "invalid_env"),
        ({"env": "dev", "stages": []}, "stages_required"),
        ({"env": "dev", "stages": [{"module": "a", "mode": "x", "pin": "1"}]}, "stage_1_invalid"),
        ({"env": "dev", "stages": [{"module": "../a", "mode": "x"}]}, "stage_1_invalid_module"),
        ({"env": "dev", "stages": [{"module": "a", "mode": "x"}, {"module": "b"}]}, "stage_2_invalid_mode"),
        ({"env": "dev", "stages": [{"module": "a", "mode": "x", "confirm": "$(id)"}]}, "stage_1_invalid_confirm"),
    ],
)
def test_parse_rejects_invalid_settings(settings: object, code: str) -> None:
    with pytest.raises(PipelineConfigError, match=f"^{code}$"):
        parse(settings)


def test_load_reports_missing_and_malformed_files(tmp_path: Path) -> None:
    with pytest.raises(PipelineConfigError, match="^config_not_found$"):
        load(tmp_path / "pipeline.dev.json")
    (tmp_path / "pipeline.dev.json").write_text("{not json")
    with pytest.raises(PipelineConfigError, match="^config_not_valid_json$"):
        load(tmp_path / "pipeline.dev.json")


@pytest.mark.parametrize("name", ["pipeline.json", "settings.json", "pipeline.example.json", "pipeline.Dev.json", "pipeline.dev.yaml"])
def test_load_requires_a_pipeline_env_file_name(tmp_path: Path, name: str) -> None:
    (tmp_path / name).write_text(json.dumps(_VALID))
    with pytest.raises(PipelineConfigError, match=r"^config_file_name_must_be_pipeline\.<env>\.json$"):
        load(tmp_path / name)


def test_load_requires_the_env_inside_to_match_the_file_name(tmp_path: Path) -> None:
    (tmp_path / "pipeline.prod.json").write_text(json.dumps(_VALID))
    with pytest.raises(PipelineConfigError, match="^env_does_not_match_file_name$"):
        load(tmp_path / "pipeline.prod.json")
    (tmp_path / "pipeline.dev.json").write_text(json.dumps(_VALID))
    assert load(tmp_path / "pipeline.dev.json").env == "dev"


def test_available_envs_lists_config_files_but_not_the_template(tmp_path: Path) -> None:
    for name in ("pipeline.prod.json", "pipeline.dev.json", "pipeline.example.json", "pipeline.json", "notes.txt", "pipeline.uat-2.json"):
        (tmp_path / name).write_text("{}")
    assert available_envs(tmp_path) == ["dev", "prod", "uat-2"]
    assert available_envs(tmp_path / "missing") == []


def test_stage_for_numbered_and_unique_stages() -> None:
    pipeline = parse({"env": "dev", "stages": [{"module": "a", "mode": "x"}, {"module": "b", "mode": "y"}, {"module": "a", "mode": "z"}]})
    assert stage_for(pipeline, "a", "3").mode == "z"
    assert stage_for(pipeline, "b").mode == "y"
    for module, number, code in [
        ("a", "", "module_in_several_stages_pass_stage"),
        ("c", "", "module_not_in_pipeline"),
        ("b", "1", "stage_module_mismatch"),
        ("a", "4", "stage_out_of_range"),
        ("a", "x", "stage_out_of_range"),
    ]:
        with pytest.raises(PipelineConfigError, match=f"^{code}$"):
            stage_for(pipeline, module, number)


def test_read_stage_cli_prints_settings_for_launchers(tmp_path: Path) -> None:
    path = tmp_path / "pipeline.dev.json"
    path.write_text(json.dumps(_VALID))
    stage = subprocess.run([sys.executable, str(READ_STAGE), str(path), "b-mod", "2"], capture_output=True, text=True)
    assert stage.returncode == 0 and stage.stdout.splitlines() == ["env=dev", "mode=sheet-rebuild", "confirm=dev"]
    env = subprocess.run([sys.executable, str(READ_STAGE), str(path), "--env"], capture_output=True, text=True)
    assert env.stdout.splitlines() == ["env=dev"]
    missing = subprocess.run([sys.executable, str(READ_STAGE), str(tmp_path / "pipeline.qa.json"), "a-mod"], capture_output=True, text=True)
    assert missing.returncode == 1 and "config_not_found" in missing.stderr and "pipeline.example.json" in missing.stderr


def test_read_stage_cli_lists_envs(tmp_path: Path) -> None:
    for name in ("pipeline.prod.json", "pipeline.dev.json", "pipeline.example.json"):
        (tmp_path / name).write_text("{}")
    listed = subprocess.run([sys.executable, str(READ_STAGE), "--list-envs", str(tmp_path)], capture_output=True, text=True)
    assert listed.returncode == 0 and listed.stdout.splitlines() == ["dev", "prod"]


def test_run_after_failure_is_an_optional_boolean() -> None:
    pipeline = parse({"env": "dev", "stages": [{"module": "a", "mode": "x"}, {"module": "b", "mode": "y", "run_after_failure": True}]})
    assert [stage.run_after_failure for stage in pipeline.stages] == [False, True]
    with pytest.raises(PipelineConfigError, match="^stage_1_invalid_run_after_failure$"):
        parse({"env": "dev", "stages": [{"module": "a", "mode": "x", "run_after_failure": "yes"}]})
