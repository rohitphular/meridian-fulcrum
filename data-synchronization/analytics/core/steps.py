"""The build steps, in order: the mart first, then the reports that read it."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from core import mart, predefined_step, user_defined
from core.context import BuildContext

STEPS: list[tuple[str, Callable[[Any, BuildContext], None]]] = [
    ("mart", mart.step),
    ("predefined", predefined_step.step),
    ("user_defined", user_defined.step),
]
