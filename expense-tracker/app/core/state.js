export const state = {
  transactions:  [],
  categories:    [],
  accounts:      [],
  accountMap:    {},   // { 'acc-001': account }  — keyed by account id
  rates:         [],
  rateMap:       {},   // { GBP: 1, INR: 105, … }  units per 1 GBP
  quoteCurrency: 'GBP',

  dateRange:  'this_month',
  customFrom: '',
  customTo:   '',

  filters: {
    types:               [],
    accounts:            [],
    major:               [],
    minor:               [],
    tx_location_country: '',
    tx_location_city:    '',
    tx_location_area:    '',
    tag:                 '',
    search:              '',
  },

  txSort:    { col: 'tx_date_time', dir: 'desc' },
  txPage:    1,
  txPerPage: 50,

  catFilterOpen: false,
  catFilters: {
    type:                 'all',
    major:                'all',
    minor:                'all',
    search:               '',
    sourceMandatory:      'all',
    targetMandatory:      'all',
    subscriptionEligible: 'all',
    recordStatuses:       ['active', 'inactive', 'deleted', 'locked'],
  },
  catAddOpen:   false,
  catViewRow:   null,
  catEditRow:   null,
  catDeleteRow: null,

  rateAddOpen:        false,
  rateEditCurrency:   null,
  rateDeleteCurrency: null,
  rateDeleteBlocked:  null,   // { error, referenced_count } when delete is refused — paired with rateDeleteCurrency

  accountSchema:      null,  // { types, liability_types, loan_types, investment_sub_types, mortgage_sub_types }
  transactionSchema:  null,  // { types, categorisation_fields, transfer_fields }
  categorySchema:     null,  // { types, account_types }

  accAddOpen:       false,
  accImportOpen:    false,
  accViewRow:       null,
  accEditRow:       null,
  accDeleteRow:     null,
  accDeleteBlocked: null,   // { referenced_count: N } when deletion is refused — paired with accDeleteRow

  catImportOpen:  false,

  txAddOpen:      false,
  txImportOpen:   false,
  txEditRow:      null,
  txDeleteRow:    null,
  txViewRow:      null,
  txCopyPrefill:  null,

  suggestionsOpen:    true,   // panel open by default
  suggestions:        [],     // cached suggestion list for the session
  suggestionsLoaded:  false,  // true after first fetch
  suggestionsFetching: false, // true while fetch is in-flight

  metadata:       null,   // { countries, cities, areas, counterparties, tags }
  metadataLoaded: false,

  insightId:            '00-earn-burn-rate',
  insightPeriod:        'last_3',
  insightCustomFrom:    '',
  insightCustomTo:      '',
  insightTab:           'transactions',
  insightChartInstance: null,
  insightDrillMajor:    null,   // active major category for 11-category-drilldown (null = top level)
  insightDrillMinor:    null,
  insightMode:          'precomputed',  // 'precomputed' | 'live'

  advisorMessages: [],

  subscriptions:  [],
  subAddOpen:     false,
  subImportOpen:  false,
  subEditRow:     null,
  subDeleteRow:   null,
  subPrefill:     null,  // { name, counterparty_name, amount, currency, source_account, major_category, minor_category, tags }
};
