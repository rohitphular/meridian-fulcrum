TX_TYPE_MONEY_IN       = 'money-in'
TX_TYPE_MONEY_OUT      = 'money-out'
TX_TYPE_MONEY_TRANSFER = 'money-transfer'


class TxField:
    ID               = 'id'
    DATE_TIME        = 'tx_date_time'
    TYPE             = 'tx_type'
    AMOUNT           = 'amount'
    CURRENCY         = 'currency'
    FX_RATE          = 'fx_rate'
    MAJOR_CATEGORY   = 'major_category'
    MINOR_CATEGORY   = 'minor_category'
    COUNTERPARTY     = 'counterparty_name'
    SOURCE_ACCOUNT   = 'source_account'
    TARGET_ACCOUNT   = 'target_account'
    LOCATION_COUNTRY = 'tx_location_country'
    LOCATION_CITY    = 'tx_location_city'
    TAGS             = 'tags'


class AccountField:
    ID            = 'id'
    NAME          = 'name'
    TYPE          = 'type'
    SUB_TYPE      = 'sub_type'
    CURRENCY      = 'currency'
    OPENING_VALUE = 'opening_value'
    IS_ACTIVE     = 'is_active'
