import os
import tempfile
from pathlib import Path

os.environ.setdefault("MERIDIAN_LOG_ROOT", str(Path(tempfile.gettempdir()) / "meridian-consolidated-pipeline-tests"))

# Tests must never pick up real stored credentials from the developer's shell.
os.environ.pop("MERIDIAN_FULCRUM_PIN", None)
os.environ.pop("MERIDIAN_FULCRUM_SECRET", None)

import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def _reports_in_a_temporary_folder(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Tests never write run reports into the real output/data folder."""
    import core.config as config

    monkeypatch.setattr(config, "OUTPUT_DATA_DIR", tmp_path / "reports")
