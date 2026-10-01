from __future__ import annotations

from collections.abc import Callable

from py_logging import get_logger

import steps.check_files as check_files
import steps.drop_tabs as drop_tabs
import steps.fill_ids as fill_ids
import steps.load_data as load_data
import steps.order_tabs as order_tabs
from core.context import LoadContext
from core.gas_client import expect_ok

logger = get_logger(__name__)

MODES = ("sheet-rebuild", "sheet-sync")


class LedgerSheetLoadJob:
    """Loads local CSV files into the Sheet. Every change is made by the GAS web app."""

    def __init__(self, context: LoadContext) -> None:
        self._context = context

    def sign_in(self, totp: str) -> None:
        """Checks the PIN and authenticator code, as the app's login does (verify)."""
        expect_ok("sign_in", self._context.client.get("verify", totp=totp))
        logger.info("loader: signed_in=true")

    def run(self, mode: str, totp: str | None) -> None:
        """Runs every step for the mode. totp=None skips the sign-in step: the caller
        (the pipeline) already signed in with this PIN; every later call carries the PIN."""
        if mode not in MODES:
            raise ValueError("invalid_mode")
        plan: list[tuple[str, Callable[[], object]]] = []
        if totp is not None:
            code = totp
            plan.append(("sign_in", lambda: self.sign_in(code)))
        plan += [("fill_ids", lambda: fill_ids.run(self._context)), ("check_files", lambda: check_files.run(self._context))]
        if mode == "sheet-rebuild":
            plan.append(("drop_tabs", lambda: drop_tabs.run(self._context)))
        plan += [("load_data", lambda: load_data.run(self._context)), ("order_tabs", lambda: order_tabs.run(self._context))]
        for number, (name, step) in enumerate(plan, start=1):
            logger.info(f"loader: step={number}/{len(plan)} name={name}")
            step()
