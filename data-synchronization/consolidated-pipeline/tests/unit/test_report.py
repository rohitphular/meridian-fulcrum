import json
import re
from pathlib import Path

from core.pipeline_config import parse
from core.report import RunReport

_PIN = "9731"


def _report(tmp_path: Path) -> RunReport:
    report = RunReport(tmp_path / "data", tmp_path / "config" / "pipeline.dev.json", tmp_path)
    pipeline = parse({"env": "dev", "stages": [{"module": "a-mod", "mode": "x"}, {"module": "b-mod", "mode": "y", "run_after_failure": True}]})
    report.set_pipeline(pipeline.env, pipeline.stages)
    return report


def _saved(report: RunReport) -> dict:
    return json.loads(report.path.read_text())


def test_report_file_is_named_after_the_local_start_time(tmp_path: Path) -> None:
    first, second = _report(tmp_path), RunReport(tmp_path / "data", tmp_path / "x.json", tmp_path)
    assert re.fullmatch(r"\d{2}-\d{2}-\d{4}-\d{2}-\d{2}-\d{2}\.json", first.path.name)
    # Two runs in the same second never overwrite each other.
    assert second.path != first.path and second.path.name.startswith(first.path.stem)
    saved = _saved(first)
    assert saved["status"] == "running" and saved["env"] == "dev" and saved["config"] == "config/pipeline.dev.json"
    assert [stage["status"] for stage in saved["stages"]] == ["pending", "pending"]


def test_stage_lines_become_steps_events_warnings_and_errors(tmp_path: Path) -> None:
    report = _report(tmp_path)
    report.stage_started(1)
    for line in (
        "[dev] Running migrations...\n",
        "[2026-10-02 10:16:20 UTC] [INFO ] [database.transactions] upsert_transactions: progress processed=25/597 succeeded=25 failed=0 skipped=0 elapsed_s=26\n",
        "[2026-10-02 10:16:21 UTC] [WARN ] [database.accounts] upsert_accounts: row_failed row=13 error_type=ValueError\n",
        "[2026-10-02 10:16:22 UTC] [ERROR] [__main__] runner: job_failed error=RuntimeError reason=entity_rows_failed:account_master\n",
        "FAILED: load:a.csv\n",
        '{"ok": false, "errors": ["Row 3: amount 1475.00 for ' + _PIN + '"]}\n',
        "[prod] another env's line\n",
    ):
        report.stage_line(1, line)
    report.stage_finished(1, 1, 3.2)
    stage = _saved(report)["stages"][0]
    assert stage["status"] == "failed" and stage["exit_code"] == 1 and stage["lines"] == 7
    assert [step["text"] for step in stage["steps"]] == ["Running migrations..."]
    assert stage["events"][0] == {
        "t": "2026-10-02 10:16:20Z",
        "logger": "database.transactions",
        "event": "upsert_transactions",
        "values": {"processed": "25/597", "succeeded": "25", "failed": "0", "skipped": "0", "elapsed_s": "26"},
    }
    assert [entry["logger"] for entry in stage["warnings"]] == ["database.accounts"]
    assert [entry["logger"] for entry in stage["errors"]] == ["__main__"]
    # Free-form output (e.g. a printed failed response) is never stored.
    assert _PIN not in report.path.read_text() and "1475.00" not in report.path.read_text()


def test_finish_marks_unstarted_stages_and_totals(tmp_path: Path) -> None:
    report = _report(tmp_path)
    report.stage_started(1)
    report.stage_line(1, "[2026-10-02 10:16:21 UTC] [WARN ] [x] thing: a=1\n")
    report.stage_finished(1, 1, 1.0)
    report.finish("failed", "stage_failed:stage=1:a-mod")
    saved = _saved(report)
    assert saved["status"] == "failed" and saved["failure_reason"] == "stage_failed:stage=1:a-mod"
    assert [stage["status"] for stage in saved["stages"]] == ["failed", "not_run"]
    assert saved["totals"] == {"stages": 2, "ok": 0, "failed": 1, "not_run": 1, "warnings": 1, "errors": 0}
    assert saved["finished_at"] and saved["duration_seconds"] >= 0
    assert not list((tmp_path / "data").glob("*.tmp")), "writes are atomic"


def test_a_manifest_lists_every_report_newest_first(tmp_path: Path) -> None:
    data = tmp_path / "data"
    data.mkdir()
    for name in ("01-10-2026-09-00-00.json", "02-10-2026-08-00-00.json", "15-09-2026-23-59-59.json", "notes.txt", "index.json.tmp"):
        (data / name).write_text("{}")
    report = _report(tmp_path)
    manifest = json.loads((data / "index.json").read_text())
    assert manifest["reports"][0] == report.path.name
    assert manifest["reports"][1:] == ["02-10-2026-08-00-00.json", "01-10-2026-09-00-00.json", "15-09-2026-23-59-59.json"]
    report.finish("ok")
    assert json.loads((data / "index.json").read_text())["reports"][0] == report.path.name
