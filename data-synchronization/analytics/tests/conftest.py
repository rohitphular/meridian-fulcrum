import os
import tempfile
from pathlib import Path

os.environ.setdefault("MERIDIAN_LOG_ROOT", str(Path(tempfile.gettempdir()) / "meridian-analytics-tests"))
