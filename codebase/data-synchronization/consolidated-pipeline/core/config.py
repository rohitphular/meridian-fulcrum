from __future__ import annotations

import os
from pathlib import Path

# Consumed by py-logging at import time; asserted here so a missing var raises KeyError
# from config at startup rather than producing a silently mis-configured logger.
_MERIDIAN_LOG_ROOT: str = os.environ["MERIDIAN_LOG_ROOT"]

DATA_SYNC_ROOT = Path(__file__).resolve().parents[2]
REPOSITORY_ROOT = DATA_SYNC_ROOT.parent.parent  # data-synchronization lives in codebase/
# Run reports for output/index.html (gitignored).
OUTPUT_DATA_DIR = Path(__file__).resolve().parents[1] / "output" / "data"
CONFIG_DIR = Path(__file__).resolve().parents[1] / "config"
