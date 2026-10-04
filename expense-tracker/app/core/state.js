// UI state only. Data comes from the server: state.context (get_app_context)
// and state.views (the last view payload per screen). No entity collections,
// rate maps or derived figures are kept in the browser.
export const state = {
  context: null,   // get_app_context data: schemas, quote_currencies, options, periods
  views:   {},     // latest view payloads by action (e.g. views.get_home_view)
  accountTypeSchema: null,   // get_app_context schemas.account_type (set by loadAll)
  accountTypesOpen: false,
  accountTypeFilterOpen: false,
  accountTypeFilterType: 'all',
  accountTypeFilterDraft: null,
  accountTypePanel: null,
  accountTypeDraft: {},
  accountTypeViewId: null,
  accountTypeDeleteId: null,
  accountTypeSearch: '',
  accountTypeStatus: 'all',
  accountTypeImport: null,
  accountTypeExport: null,   // { data: export_account_types data | null, error } while the export panel is open
  accountTypeBusy: false,
  quoteCurrency: 'GBP',

  // Deep link into Transactions (other sections assign a new object; see
  // transactions.js _consumeDeepLink).
  filters: {
    types:               [],
    accounts:            [],
    major:               [],
    minor:               [],
    user_location_country: '',
    user_location_city:    '',
    user_location_area:    '',
    tag:                 '',
    search:              '',
  },

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


  // Schemas from get_app_context (set by main.js loadAll) that sections read.
  categorySchema:     null,  // { types, account_types, record_statuses }
  subscriptionSchema: null, // { frequencies, tx_types, record_statuses, default_timezone }

  accAddOpen:       false,
  accImportOpen:    false,
  // Open panels hold record ids (never Sheet row numbers, which can move).
  accViewRow:       null,
  accEditRow:       null,
  accDeleteRow:     null,
  accDeleteBlocked: null,   // { referenced_count: N } when deletion is refused — paired with accDeleteRow

  accFilterOpen: false,
  accFilters: {
    type:           'all',
    subType:        'all',
    currency:       'all',
    search:         '',
    recordStatuses: ['active', 'inactive', 'deleted', 'locked'],
  },

  catImportOpen:  false,
  catImportReport: null,
  catImportBusy: false,

  txImportOpen:   false,

  suggestionsOpen:    true,   // panel open by default
  suggestions:        [],     // cached suggestion list for the session
  suggestionsLoaded:  false,  // true after first fetch
  suggestionsFetching: false, // true while fetch is in-flight

  // Reports (sections/reports.js). Panels hold report ids; the builder draft
  // is the form being edited (sent as typed; the server validates on save).
  reportsMenu:        'predefined',  // 'predefined' | 'mine'
  reportsShowDeleted: false,         // My reports: list_reports_view include_deleted
  reportDeleteId:     null,          // report id pending the inline delete confirmation
  reportBuilder:      null,          // { mode: 'create' | 'edit', id, draft, error } while the builder is open
  reportView:         null,          // { id, title, period, tab, controls: {}, drill } while a report is open

  // Home (sections/home.js) customise mode: { slots: { slot: { report_id, title, report_type } },
  // picker: { slot, query } | null, error } while editing; null otherwise.
  homeCustomise:      null,

  advisorMessages: [],

  subAddOpen:     false,
  subImportOpen:  false,
  subEditRow:     null,
  subDeleteRow:   null,
  subPrefill:     null,  // { name, counterparty_name, amount, source_account, tx_type, major_category, minor_category, tx_tags }

  subFilterOpen:  false,
  subFilters: {
    recordStatuses: ['active', 'inactive', 'deleted', 'locked'],
    majorCategory:  'all',
    frequency:      'all',
    search:         '',
  },
  subSort: { col: 'next_payment_date', dir: 'asc' },
};
