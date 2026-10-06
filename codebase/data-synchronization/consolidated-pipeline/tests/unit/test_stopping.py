"""Stopping a run with real processes: launcher (bash) → forwarder (like `uv run`) → job.

`uv run` forwards SIGINT to its child, so a stop that signals every process interrupts
the job twice. These tests count the SIGINTs the job receives and check that its
clean-up (standing in for the load storing its outcomes) completes.
"""

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

import core.runner as runner

# Counts SIGINTs; on the first, runs a 1 s "flush" then exits 130. Prints "ready" when started.
_JOB = """import os, signal, sys, time
state = os.environ["JOB_STATE"]
count = 0
def on_int(signum, frame):
    global count
    count += 1
    with open(state, "w") as out:
        out.write(f"sigints={count}\\n")
signal.signal(signal.SIGINT, on_int)
print("ready", flush=True)
while count == 0:
    time.sleep(0.05)
time.sleep(1.0)
with open(state, "a") as out:
    out.write("flushed\\n")
sys.exit(130)
"""

# Like `uv run`: forwards SIGINT to its child and exits with the child's status.
_FORWARDER = """import signal, subprocess, sys
child = subprocess.Popen([sys.executable, sys.argv[1]])
signal.signal(signal.SIGINT, lambda signum, frame: child.send_signal(signal.SIGINT))
sys.exit(child.wait())
"""


@pytest.fixture
def stage_tree(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict:
    (tmp_path / "job.py").write_text(_JOB)
    (tmp_path / "forward.py").write_text(_FORWARDER)
    launcher = tmp_path / "launcher.sh"
    launcher.write_text(f'set -euo pipefail\n"{sys.executable}" "{tmp_path / "forward.py"}" "{tmp_path / "job.py"}"\n')
    state = tmp_path / "state.txt"
    monkeypatch.setenv("JOB_STATE", str(state))
    saved = {signum: signal.getsignal(signum) for signum in runner._STOP_SIGNALS}
    yield {"launcher": launcher, "state": state, "dir": tmp_path}
    for signum, handler in saved.items():
        signal.signal(signum, handler)


def _jobs_left(directory: Path) -> list[str]:
    return subprocess.run(["pgrep", "-f", str(directory)], capture_output=True, text=True).stdout.split()


def test_a_stop_interrupts_the_job_once_and_lets_it_finish_its_clean_up(stage_tree: dict) -> None:
    def on_line(line: str) -> None:
        if line.strip() == "ready":
            raise KeyboardInterrupt

    with pytest.raises(KeyboardInterrupt):
        runner._run_process(["bash", str(stage_tree["launcher"])], None, on_line=on_line)
    assert stage_tree["state"].read_text() == "sigints=1\nflushed\n"
    assert _jobs_left(stage_tree["dir"]) == []


def test_a_job_that_ignores_the_stop_is_killed_after_the_grace_period(stage_tree: dict) -> None:
    (stage_tree["dir"] / "job.py").write_text('import signal, time\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\nprint("ready", flush=True)\ntime.sleep(60)\n')
    process = subprocess.Popen(["bash", str(stage_tree["launcher"])], stdout=subprocess.PIPE, text=True, start_new_session=True)
    assert process.stdout is not None and process.stdout.readline().strip() == "ready"
    started = time.monotonic()
    runner._stop_stage(process, grace_seconds=1)
    assert time.monotonic() - started < 5
    assert _jobs_left(stage_tree["dir"]) == []


def test_stop_refuses_a_process_outside_its_own_session(stage_tree: dict) -> None:
    process = subprocess.Popen(["sleep", "30"])
    try:
        with pytest.raises(ValueError, match="stage_not_in_own_session"):
            runner._stop_stage(process)
    finally:
        process.kill()
        process.wait()


# The pipeline itself, run as its own process with one fake stage.
_DRIVER = """import json, sys
from pathlib import Path
import core.config as config
import core.runner as runner
settings = json.loads(sys.argv[1])
config.DATA_SYNC_ROOT = Path(settings["data_sync"])
config.OUTPUT_DATA_DIR = Path(settings["output"])
sys.argv = ["consolidated-pipeline", "--config", settings["config"]]
runner.main()
"""


@pytest.mark.parametrize("stop", ["sigterm", "sighup", "double_sigint"])
def test_a_stopped_pipeline_stops_its_stage_cleanly_and_reports_interrupted(stage_tree: dict, stop: str) -> None:
    directory = stage_tree["dir"]
    cicd = directory / "data-synchronization" / "forex-database-load" / "cicd"
    cicd.mkdir(parents=True)
    (cicd / "check.sh").write_text("exit 0\n")
    (cicd / "start-up.sh").write_text(stage_tree["launcher"].read_text())
    config_file = directory / "pipeline.dev.json"
    config_file.write_text(json.dumps({"env": "dev", "stages": [{"module": "forex-database-load", "mode": "daily"}]}))
    driver = directory / "driver.py"
    driver.write_text(_DRIVER)
    settings = {"data_sync": str(directory / "data-synchronization"), "output": str(directory / "data"), "config": str(config_file)}
    environment = {**os.environ, "PYTHONPATH": str(Path(runner.__file__).resolve().parents[1]), "MERIDIAN_LOG_ROOT": str(directory / "logs")}
    # Its own session stands in for the terminal's process group.
    pipeline = subprocess.Popen([sys.executable, str(driver), json.dumps(settings)], stdout=subprocess.PIPE, text=True, env=environment, start_new_session=True)
    assert pipeline.stdout is not None
    for line in pipeline.stdout:
        if line.strip() == "ready":
            break
    if stop == "double_sigint":
        # Ctrl-C under `uv run`: the terminal's SIGINT plus the one uv forwards.
        os.killpg(pipeline.pid, signal.SIGINT)
        os.killpg(pipeline.pid, signal.SIGINT)
    else:
        os.killpg(pipeline.pid, signal.SIGTERM if stop == "sigterm" else signal.SIGHUP)
    pipeline.stdout.read()
    assert pipeline.wait(timeout=30) == 1
    assert stage_tree["state"].read_text() == "sigints=1\nflushed\n"
    assert _jobs_left(directory / "forward.py") == [] and _jobs_left(directory / "job.py") == []
    reports = [path for path in (directory / "data").glob("*.json") if path.name != "index.json"]
    saved = json.loads(reports[0].read_text())
    assert saved["status"] == "interrupted"
    assert saved["failure_reason"] == ("interrupted" if stop == "double_sigint" else f"signal:{stop}")
    assert saved["stages"][0]["status"] == "failed"
    assert sorted(path.name for path in (directory / "data").iterdir() if path.name.startswith(".")) == []
