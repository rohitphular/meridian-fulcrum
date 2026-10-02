"""Run report: one JSON file per pipeline run, read by output/index.html.

`output/data/dd-mm-yyyy-hh-mm-ss.json` (local start time) is rewritten as the run
progresses, so the monitor page can follow a run live. Only structured py-logging
lines and the launchers' own step lines are kept: both carry codes, names and
counts, never credentials or cell values. Free-form output (such as a failed
response printed by a module) is not stored.
"""

from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import time
from datetime import datetime
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1
_LOG_LINE = re.compile(r"^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) UTC\] \[(\w+)\s*\] \[([^\]]+)\] (.*)$")
# A launcher step, e.g. "[dev] Running migrations..." or "[dev] Check passed: ...".
_STEP_LINE = re.compile(r"^\[([a-z][a-z0-9-]*)\] (.+)$")
_EVENT = re.compile(r"^([A-Za-z_][\w.]*): (.*)$")
_VALUE = re.compile(r"(\w+)=(\S+)")
_LIMITS = {"log_tail": 80, "warnings": 60, "errors": 60, "events": 600, "steps": 40}
_SAVE_INTERVAL_S = 2.0
# Static servers (e.g. an IDE's built-in one) do not list folders, so the page reads this manifest.
MANIFEST = "index.json"
_REPORT_NAME = re.compile(r"^\d{2}-\d{2}-\d{4}-\d{2}-\d{2}-\d{2}(?:-\d+)?\.json$")


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _code_version(root: Path) -> str:
    try:
        completed = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=root, capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return ""
    return completed.stdout.strip() if completed.returncode == 0 else ""


def _sort_key(name: str) -> tuple[str, int]:
    """dd-mm-yyyy-hh-mm-ss[-n].json → sortable (yyyy mm dd hh mm ss, n)."""
    parts = name[: -len(".json")].split("-")
    day, month, year, hour, minute, second = parts[:6]
    return f"{year}{month}{day}{hour}{minute}{second}", int(parts[6]) if len(parts) > 6 else 1


def write_manifest(directory: Path) -> None:
    """List every report in the folder (newest first) in data/index.json."""
    names = sorted((path.name for path in directory.iterdir() if _REPORT_NAME.fullmatch(path.name)), key=_sort_key, reverse=True)
    # Per process: two runs finishing together must not share a temporary file.
    temporary = directory / f".{MANIFEST}.{os.getpid()}.tmp"
    temporary.write_text(json.dumps({"updated_at": _now(), "reports": names}, indent=1))
    temporary.replace(directory / MANIFEST)


def _append(items: list[Any], item: Any, limit: int) -> None:
    items.append(item)
    if len(items) > limit:
        del items[: len(items) - limit]


class RunReport:
    def __init__(self, output_dir: Path, config_path: Path, repository_root: Path) -> None:
        self._dir = output_dir
        self._dir.mkdir(parents=True, exist_ok=True)
        started = datetime.now().astimezone()
        run_id = started.strftime("%d-%m-%Y-%H-%M-%S")
        suffix = 1
        while (self._dir / f"{run_id}.json").exists():
            suffix += 1
            run_id = f"{started.strftime('%d-%m-%Y-%H-%M-%S')}-{suffix}"
        self.path = self._dir / f"{run_id}.json"
        self._started = time.monotonic()
        self._last_save = 0.0
        try:
            config_label = str(config_path.relative_to(repository_root))
        except ValueError:
            config_label = config_path.name
        self.data: dict[str, Any] = {
            "schema_version": SCHEMA_VERSION,
            "run_id": run_id,
            "status": "running",
            "failure_reason": "",
            "env": "",
            "config": config_label,
            "host": socket.gethostname(),
            "code_version": _code_version(repository_root),
            "started_at": started.isoformat(timespec="seconds"),
            "finished_at": "",
            "duration_seconds": 0.0,
            "credentials": "not_needed",
            "sign_in": None,
            "preflight": [],
            "stages": [],
            "totals": {},
        }
        self.save(force=True)
        self.write_manifest()

    # ── Setup ──────────────────────────────────────────────────────────────────

    def set_pipeline(self, env: str, stages: list[Any]) -> None:
        self.data["env"] = env
        self.data["stages"] = [
            {
                "number": stage.number,
                "module": stage.module,
                "mode": stage.mode,
                "run_after_failure": stage.run_after_failure,
                "status": "pending",
                "exit_code": None,
                "started_at": "",
                "finished_at": "",
                "seconds": 0.0,
                "steps": [],
                "events": [],
                "warnings": [],
                "errors": [],
                "log_tail": [],
                "lines": 0,
            }
            for stage in stages
        ]
        self.save(force=True)

    def preflight(self, stage: Any, ok: bool, seconds: float, message: str = "") -> None:
        self.data["preflight"].append({"number": stage.number, "module": stage.module, "mode": stage.mode, "ok": ok, "seconds": round(seconds, 2), "message": message[:300]})
        self.save(force=True)

    def credentials(self, mode: str) -> None:
        self.data["credentials"] = mode
        self.save(force=True)

    def sign_in(self, stage: Any, ok: bool, seconds: float) -> None:
        self.data["sign_in"] = {"number": stage.number, "module": stage.module, "ok": ok, "seconds": round(seconds, 2)}
        self.save(force=True)

    # ── Stages ─────────────────────────────────────────────────────────────────

    def _stage(self, number: int) -> dict[str, Any]:
        return next(stage for stage in self.data["stages"] if stage["number"] == number)

    def stage_started(self, number: int) -> None:
        stage = self._stage(number)
        stage.update(status="running", started_at=_now())
        self.save(force=True)

    def stage_line(self, number: int, line: str) -> None:
        stage = self._stage(number)
        stage["lines"] += 1
        text = line.rstrip("\n")
        logged = _LOG_LINE.match(text)
        if logged:
            timestamp, level, source, message = logged.groups()
            entry = {"t": timestamp + "Z", "level": level.strip(), "logger": source, "message": message[:400]}
            _append(stage["log_tail"], entry, _LIMITS["log_tail"])
            if entry["level"] in ("WARN", "WARNING"):
                _append(stage["warnings"], entry, _LIMITS["warnings"])
            elif entry["level"] in ("ERROR", "CRIT"):
                _append(stage["errors"], entry, _LIMITS["errors"])
            event = _EVENT.match(message)
            if event:
                values = dict(_VALUE.findall(event.group(2)))
                if values:
                    _append(stage["events"], {"t": entry["t"], "logger": source, "event": event.group(1), "values": values}, _LIMITS["events"])
        else:
            step = _STEP_LINE.match(text)
            if step and step.group(1) == self.data["env"]:
                _append(stage["steps"], {"t": _now(), "text": step.group(2)[:200]}, _LIMITS["steps"])
        self.save()

    def stage_finished(self, number: int, exit_code: int, seconds: float) -> None:
        stage = self._stage(number)
        stage.update(status="ok" if exit_code == 0 else "failed", exit_code=exit_code, finished_at=_now(), seconds=round(seconds, 2))
        self.save(force=True)

    # ── Finish ─────────────────────────────────────────────────────────────────

    def finish(self, status: str, reason: str = "") -> None:
        for stage in self.data["stages"]:
            if stage["status"] in ("pending", "running"):
                stage["status"] = "not_run" if stage["status"] == "pending" else "failed"
        stages = self.data["stages"]
        self.data.update(
            status=status,
            failure_reason=reason,
            finished_at=_now(),
            duration_seconds=round(time.monotonic() - self._started, 2),
            totals={
                "stages": len(stages),
                "ok": sum(stage["status"] == "ok" for stage in stages),
                "failed": sum(stage["status"] == "failed" for stage in stages),
                "not_run": sum(stage["status"] == "not_run" for stage in stages),
                "warnings": sum(len(stage["warnings"]) for stage in stages),
                "errors": sum(len(stage["errors"]) for stage in stages),
            },
        )
        self.save(force=True)
        self.write_manifest()

    @property
    def finished(self) -> bool:
        return self.data["status"] != "running"

    def write_manifest(self) -> None:
        write_manifest(self._dir)

    def save(self, *, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self._last_save < _SAVE_INTERVAL_S:
            return
        self._last_save = now
        if self.data["status"] == "running":
            self.data["duration_seconds"] = round(now - self._started, 2)
        temporary = self.path.with_name(f".{self.path.name}.{os.getpid()}.tmp")
        temporary.write_text(json.dumps(self.data, indent=1))
        temporary.replace(self.path)
