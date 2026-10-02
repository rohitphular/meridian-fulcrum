import os
import tempfile
from pathlib import Path

os.environ.setdefault("MERIDIAN_LOG_ROOT", str(Path(tempfile.gettempdir()) / "meridian-consolidated-pipeline-tests"))

# Tests must never pick up real stored credentials from the developer's shell.
os.environ.pop("MERIDIAN_FULCRUM_PIN", None)
os.environ.pop("MERIDIAN_FULCRUM_SECRET", None)
