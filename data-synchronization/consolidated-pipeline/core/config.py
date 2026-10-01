from __future__ import annotations

import os
from pathlib import Path

# Consumed by py-logging at import time; asserted here so a missing var raises KeyError
# from config at startup rather than producing a silently mis-configured logger.
_MERIDIAN_LOG_ROOT: str = os.environ["MERIDIAN_LOG_ROOT"]

DATA_SYNC_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = Path(__file__).resolve().parents[1] / "pipeline.json"
