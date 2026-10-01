#!/usr/bin/env python3
"""Prints one stage's settings from the pipeline config for a module launcher.

Usage:
  read-stage.py CONFIG MODULE [STAGE]   → env=…, mode=…, confirm=… lines
  read-stage.py CONFIG --env            → env=… line
Runs with the system python3 (standard library only); errors go to stderr with exit 1.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core.pipeline_config import PipelineConfigError, load, stage_for  # noqa: E402


def main(arguments: list[str]) -> int:
    if len(arguments) not in (2, 3):
        print("ERROR: usage: read-stage.py CONFIG MODULE [STAGE] | CONFIG --env", file=sys.stderr)
        return 1
    path = Path(arguments[0])
    try:
        config = load(path)
        if arguments[1] == "--env":
            print(f"env={config.env}")
            return 0
        stage = stage_for(config, arguments[1], arguments[2] if len(arguments) == 3 else "")
    except PipelineConfigError as error:
        hint = " (copy data-synchronization/consolidated-pipeline/pipeline.example.json to pipeline.json)" if str(error) == "config_not_found" else ""
        print(f"ERROR: pipeline config {path}: {error}{hint}", file=sys.stderr)
        return 1
    print(f"env={config.env}")
    print(f"mode={stage.mode}")
    print(f"confirm={stage.confirm}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
