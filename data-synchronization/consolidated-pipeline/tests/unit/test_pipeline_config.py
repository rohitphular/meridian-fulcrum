import json
import subprocess
import sys
from pathlib import Path

import pytest

from core.pipeline_config import PipelineConfigError, Stage, load, parse, stage_for

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
        load(tmp_path / "missing.json")
    (tmp_path / "bad.json").write_text("{not json")
    with pytest.raises(PipelineConfigError, match="^config_not_valid_json$"):
        load(tmp_path / "bad.json")


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
    path = tmp_path / "pipeline.json"
    path.write_text(json.dumps(_VALID))
    stage = subprocess.run([sys.executable, str(READ_STAGE), str(path), "b-mod", "2"], capture_output=True, text=True)
    assert stage.returncode == 0 and stage.stdout.splitlines() == ["env=dev", "mode=sheet-rebuild", "confirm=dev"]
    env = subprocess.run([sys.executable, str(READ_STAGE), str(path), "--env"], capture_output=True, text=True)
    assert env.stdout.splitlines() == ["env=dev"]
    missing = subprocess.run([sys.executable, str(READ_STAGE), str(tmp_path / "none.json"), "a-mod"], capture_output=True, text=True)
    assert missing.returncode == 1 and "config_not_found" in missing.stderr and "pipeline.example.json" in missing.stderr
