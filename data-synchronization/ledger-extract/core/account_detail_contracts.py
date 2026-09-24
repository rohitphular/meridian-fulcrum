"""The six account-extension Sheets and their identically named database tables."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType

DETAIL_SYNC_METADATA = ("record_status", "sync_status", "sync_date", "sync_notes", "created_at", "updated_at")
DETAIL_SYNC_IGNORED_FIELDS = frozenset(DETAIL_SYNC_METADATA[1:])


@dataclass(frozen=True)
class DetailContract:
    source_sheet: str
    target_table: str
    headers: tuple[str, ...]
    required: tuple[str, ...]
    field_map: Mapping[str, str]
    money_fields: Mapping[str, str]
    enums: Mapping[str, tuple[str, ...]]
    decimal_fields: tuple[str, ...]
    integer_fields: Mapping[str, tuple[int, int | None]]
    boolean_fields: tuple[str, ...]
    date_fields: tuple[str, ...]
    uuid_fields: tuple[str, ...]
    nonnegative_fields: tuple[str, ...]
    positive_fields: tuple[str, ...]
    percentage_fields: tuple[str, ...]


def _contract(
    source_sheet: str,
    headers: tuple[str, ...],
    *,
    required: tuple[str, ...] = (),
    renames: Mapping[str, str] | None = None,
    money_fields: Mapping[str, str] | None = None,
    enums: Mapping[str, tuple[str, ...]] | None = None,
    decimal_fields: tuple[str, ...] = (),
    integer_fields: Mapping[str, tuple[int, int | None]] | None = None,
    boolean_fields: tuple[str, ...] = (),
    date_fields: tuple[str, ...] = (),
    nonnegative_fields: tuple[str, ...] = (),
    positive_fields: tuple[str, ...] = (),
    percentage_fields: tuple[str, ...] = (),
) -> DetailContract:
    destination_names = {"account_id": "account_master_id", "account_name": "source_account_name", **(renames or {}), **(money_fields or {})}
    source_enums = dict(enums or {})
    headers = (*headers, *(field for field in DETAIL_SYNC_METADATA if field not in headers))
    source_enums["record_status"] = _RECORD_STATUSES
    return DetailContract(
        source_sheet=source_sheet,
        target_table=source_sheet,
        headers=headers,
        required=("id", "account_id", *required),
        field_map=MappingProxyType({field: destination_names.get(field, field) for field in headers if field not in DETAIL_SYNC_IGNORED_FIELDS}),
        money_fields=MappingProxyType(dict(money_fields or {})),
        enums=MappingProxyType(source_enums),
        decimal_fields=tuple(dict.fromkeys((*decimal_fields, *(money_fields or {})))),
        integer_fields=MappingProxyType(dict(integer_fields or {})),
        boolean_fields=boolean_fields,
        date_fields=date_fields,
        uuid_fields=tuple(field for field in ("id", "account_id", "linked_property_account_id", "evaluation_currency_rate_id") if field in headers),
        nonnegative_fields=nonnegative_fields,
        positive_fields=positive_fields,
        percentage_fields=percentage_fields,
    )


_RECORD_STATUSES = ("active", "inactive", "deleted", "locked")

CONTRACTS: dict[str, DetailContract] = {
    "account_deposit": _contract(
        "account_deposit",
        ("id", "account_id", "account_name", "is_interest_paid", "rate_type", "interest_payment_frequency", "interest_rate"),
        enums={"rate_type": ("fixed", "variable"), "interest_payment_frequency": ("monthly", "quarterly", "annually", "at_maturity")},
        decimal_fields=("interest_rate",),
        boolean_fields=("is_interest_paid",),
        nonnegative_fields=("interest_rate",),
    ),
    "account_liability_credit_card": _contract(
        "account_liability_credit_card",
        ("id", "account_id", "account_name", "credit_limit_local", "interest_rate", "payment_month_day", "statement_month_day"),
        required=("credit_limit_local",),
        renames={"payment_month_day": "payment_due_day", "statement_month_day": "statement_day"},
        money_fields={"credit_limit_local": "credit_limit_local_value"},
        decimal_fields=("interest_rate",),
        integer_fields={"payment_month_day": (1, 31), "statement_month_day": (1, 31)},
        nonnegative_fields=("credit_limit_local", "interest_rate"),
    ),
    "account_liability_mortgage": _contract(
        "account_liability_mortgage",
        ("id", "account_id", "account_name", "linked_property_account_id", "original_principal_local", "monthly_payment_local", "interest_rate", "rate_type", "term_months", "maturity_date_local"),
        required=("original_principal_local", "term_months"),
        money_fields={"original_principal_local": "original_principal_amount_local_value", "monthly_payment_local": "monthly_payment_local_value"},
        enums={"rate_type": ("fixed", "variable")},
        decimal_fields=("interest_rate",),
        integer_fields={"term_months": (1, None)},
        date_fields=("maturity_date_local",),
        nonnegative_fields=("monthly_payment_local", "interest_rate"),
        positive_fields=("original_principal_local",),
    ),
    "account_liability_personal_loan": _contract(
        "account_liability_personal_loan",
        ("id", "account_id", "account_name", "original_principal_local", "monthly_payment_local", "interest_rate", "term_months", "maturity_date_local"),
        required=("original_principal_local", "term_months"),
        money_fields={"original_principal_local": "original_principal_amount_local_value", "monthly_payment_local": "monthly_payment_local_value"},
        decimal_fields=("interest_rate",),
        integer_fields={"term_months": (1, None)},
        date_fields=("maturity_date_local",),
        nonnegative_fields=("monthly_payment_local", "interest_rate"),
        positive_fields=("original_principal_local",),
    ),
    "account_investment_property": _contract(
        "account_investment_property",
        (
            "id",
            "account_id",
            "account_name",
            "acquisition_type",
            "acquisition_date_local",
            "is_rented",
            "rent_frequency",
            "rent_day",
            "rent_month",
            "current_value_local",
            "property_ownership_percentage",
            "rent_amount_local",
            "rent_ownership_percentage",
            "property_service_charge_frequency",
            "property_service_charge_amount_local",
            "current_value_evaluation_date",
            "property_address",
        ),
        required=("acquisition_type",),
        money_fields={
            "current_value_local": "current_value_local_value",
            "rent_amount_local": "rent_amount_local_value",
            "property_service_charge_amount_local": "property_service_charge_amount_local_value",
        },
        enums={"acquisition_type": ("PURCHASED", "INHERITED", "GIFTED"), "rent_frequency": ("MONTHLY", "YEARLY"), "property_service_charge_frequency": ("MONTHLY", "QUARTERLY", "YEARLY")},
        decimal_fields=("property_ownership_percentage", "rent_ownership_percentage"),
        integer_fields={"rent_day": (1, 31), "rent_month": (1, 12)},
        boolean_fields=("is_rented",),
        date_fields=("acquisition_date_local", "current_value_evaluation_date"),
        nonnegative_fields=("current_value_local", "rent_amount_local", "property_service_charge_amount_local"),
        percentage_fields=("property_ownership_percentage", "rent_ownership_percentage"),
    ),
    "account_investment_stocks": _contract(
        "account_investment_stocks",
        (
            "id",
            "account_id",
            "instrument_symbol",
            "instrument_name",
            "instrument_type",
            "instrument_currency_local",
            "holding_intent",
            "position_side",
            "quantity",
            "avg_cost_price_local",
            "cost_basis_local",
            "current_price_local",
            "current_value_local",
            "price_asof_date",
            "evaluation_currency_rate_id",
            "underlying_symbol",
            "option_type",
            "strike_price_local",
            "expiry_date",
            "contract_multiplier",
            "opening_date",
            "record_status",
        ),
        required=("instrument_type",),
        renames={"quantity": "units_held"},
        money_fields={"cost_basis_local": "cost_basis_local_value", "current_value_local": "current_value_local_value"},
        enums={
            "instrument_type": ("EQUITY", "ETF", "MUTUAL_FUND", "OPTION", "FUTURE", "CASH"),
            "holding_intent": ("LONG_TERM", "SHORT_TERM", "TRADING"),
            "position_side": ("LONG", "SHORT"),
            "option_type": ("CALL", "PUT"),
            "record_status": _RECORD_STATUSES,
        },
        decimal_fields=("quantity", "avg_cost_price_local", "current_price_local", "strike_price_local", "contract_multiplier"),
        date_fields=("price_asof_date", "expiry_date", "opening_date"),
        positive_fields=("contract_multiplier",),
    ),
}

SYNC_DETAIL_SHEETS = frozenset(CONTRACTS)
