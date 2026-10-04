from typing import Any

import pytest

import core.config as config

MASTERS = ("category_master", "account_master", "transaction_master", "subscription_master")


def _settings(**overrides: Any) -> dict:
    entities = {name: {"enabled": True} for name in MASTERS}
    entities.update(overrides)
    return {"entities": entities}


def test_enabled_tabs_follow_config_order_and_skip_disabled_ones() -> None:
    settings = _settings(account_types={"enabled": True}, account_deposit={"enabled": False})
    assert config.enabled_tabs(settings) == [*MASTERS, "account_types"]


def test_the_shipped_config_is_valid() -> None:
    tabs = config.enabled_tabs(config.load_config())
    assert set(MASTERS) <= set(tabs)


def test_false_string_is_not_a_boolean() -> None:
    with pytest.raises(ValueError, match="^entity_enabled_must_be_boolean:account_master$"):
        config.enabled_tabs(_settings(account_master={"enabled": "false"}))


@pytest.mark.parametrize("entities", [None, [], {"account_master": None}, {"account_master": {"enable": True}}])
def test_malformed_entity_settings_are_rejected(entities: Any) -> None:
    settings = _settings()
    if isinstance(entities, dict):
        settings["entities"].update(entities)
    else:
        settings["entities"] = entities
    with pytest.raises(ValueError, match="configuration"):
        config.enabled_tabs(settings)


@pytest.mark.parametrize("missing", MASTERS)
def test_every_master_must_be_listed(missing: str) -> None:
    settings = _settings()
    del settings["entities"][missing]
    with pytest.raises(ValueError, match=f"^missing_entity_configuration:{missing}$"):
        config.enabled_tabs(settings)


def test_report_master_is_staged_for_the_load() -> None:
    # ledger-database-load has a report_master contract, so the tab is staged with the others.
    assert "report_master" in config.enabled_tabs(config.load_config())
