// Report builder (create / edit a user-defined report).
// Every choice, label and limit comes from the builder schema list_reports_view
// returns (report-definition.json). Options the schema rules out for the current
// choices are shown disabled and dropped from the draft; this mirrors the
// schema's own rules (chart_kinds modes / measures, measures.group_by,
// compare_rules.not_with_periods, filter_rules.transaction_only, group_by_rules)
// for presentation only. The server validates again on save and its
// { error, field, message } is shown next to the field it names.
import { esc } from '../../core/utils.js';

// Contract sentinels (report-definition.json): the "nothing" compare mode and
// time grain, the preset that takes fixed dates, the stock measure kind.
const BLD_NONE = 'none';
const BLD_FIXED = 'fixed';
const BLD_STOCK = 'stock';

// filter value_type → filter_options list that offers its values (the other
// types are typed: text lists and amounts).
const BLD_OPTION_LISTS = { uuid_list: 'accounts', category_list: 'categories', currency_list: 'currencies', tx_type_list: 'tx_types' };

function _bldFind(list, key) {
  return (list ?? []).find(item => item.key === key) ?? null;
}

function _bldGroups(draft) {
  return [draft.group_by_1, draft.group_by_2].filter(key => key !== '' && key !== undefined && key !== null);
}

// ── Schema rules (presentation of what the schema says) ─────────────────────

export function bldGroupAllowed(schema, draft, key) {
  const measure = _bldFind(schema.measures, draft.measure);
  if (measure === null) return false;
  return measure.group_by === 'all' || (Array.isArray(measure.group_by) && measure.group_by.includes(key));
}

export function bldCompareAllowed(schema, draft, key) {
  return key === BLD_NONE || !(schema.compare_rules?.not_with_periods ?? []).includes(draft.period_preset);
}

export function bldFilterAllowed(schema, draft, key) {
  const measure = _bldFind(schema.measures, draft.measure);
  return !(measure?.kind === BLD_STOCK && (schema.filter_rules?.transaction_only ?? []).includes(key));
}

export function bldChartFits(schema, draft, chart) {
  const measure = _bldFind(schema.measures, draft.measure);
  if (measure === null || !chart) return false;
  const measureOk = chart.measures === 'all' || (chart.measures === 'additive' && measure.additive === true)
    || (Array.isArray(chart.measures) && chart.measures.includes(measure.key));
  if (!measureOk) return false;
  const timed = draft.time_grain !== BLD_NONE;
  const groups = _bldGroups(draft).length;
  return (chart.modes ?? []).some(mode => (mode.time_grain === 'any' || (mode.time_grain === 'required') === timed)
    && groups >= mode.group_by_min && groups <= mode.group_by_max);
}

export function bldNeedsDates(draft) {
  return draft.period_preset === BLD_FIXED;
}

// Drops choices the schema rules out after a change (group-bys the measure does
// not allow, a compare the period does not allow, transaction filters on a stock
// measure), fills the Top N defaults while there is a breakdown and moves the
// chart to the first kind that fits. Returns the same draft.
export function bldNormalise(schema, draft) {
  if (_bldFind(schema.measures, draft.measure) === null) draft.measure = schema.measures?.[0]?.key ?? '';
  const groups = [];
  _bldGroups(draft).forEach(key => {
    if (groups.length < (schema.group_by_rules?.max ?? 2) && !groups.includes(key) && bldGroupAllowed(schema, draft, key)) groups.push(key);
  });
  draft.group_by_1 = groups[0] ?? '';
  draft.group_by_2 = groups[1] ?? '';
  const rules = schema.group_by_rules ?? {};
  if (groups.length > 0) {
    if (draft.top_n === '' || draft.top_n === null || draft.top_n === undefined) draft.top_n = String(rules.top_n_default ?? '');
    if (typeof draft.include_other !== 'boolean') draft.include_other = rules.include_other_default === true;
  } else {
    // Unset until a breakdown is chosen (then the schema defaults apply).
    draft.top_n = '';
    draft.include_other = undefined;
  }
  if (!bldCompareAllowed(schema, draft, draft.compare_mode)) draft.compare_mode = BLD_NONE;
  if (!bldNeedsDates(draft)) { draft.period_from = ''; draft.period_to = ''; }
  (schema.filters ?? []).forEach(filter => {
    if (!bldFilterAllowed(schema, draft, filter.key)) draft.filters[filter.key] = filter.value_type === 'amount' ? '' : [];
  });
  if (!bldChartFits(schema, draft, _bldFind(schema.chart_kinds, draft.chart_kind))) {
    draft.chart_kind = (schema.chart_kinds ?? []).find(chart => bldChartFits(schema, draft, chart))?.key ?? draft.chart_kind;
  }
  return draft;
}

// ── Drafts ────────────────────────────────────────────────────────────────────

function _bldEmptyFilters(schema) {
  const filters = {};
  (schema.filters ?? []).forEach(filter => { filters[filter.key] = filter.value_type === 'amount' ? '' : []; });
  return filters;
}

// A new draft: the first option of every schema list, no breakdown, no filters.
export function bldDefaultDraft(schema, name = '') {
  return bldNormalise(schema, {
    report_name: name, report_description: '',
    measure: schema.measures?.[0]?.key ?? '', period_preset: schema.period_presets?.[0]?.key ?? '', period_from: '', period_to: '',
    compare_mode: BLD_NONE, time_grain: BLD_NONE, group_by_1: '', group_by_2: '', top_n: '', include_other: undefined,
    filters: _bldEmptyFilters(schema), chart_kind: '', filter_field: '',
  });
}

// A draft from a saved definition (list_reports_view mine[].definition).
export function bldDraftFromDefinition(schema, definition, name) {
  const separator = schema.filter_rules?.list_separator ?? ';';
  const text = value => (value === undefined || value === null ? '' : String(value));
  const filters = _bldEmptyFilters(schema);
  (schema.filters ?? []).forEach(filter => {
    const raw = text(definition[filter.column]);
    filters[filter.key] = filter.value_type === 'amount' ? raw : raw.split(separator).map(item => item.trim()).filter(item => item !== '');
  });
  const other = definition.include_other;
  return bldNormalise(schema, {
    report_name: name ?? text(definition.report_name), report_description: text(definition.report_description),
    measure: text(definition.measure), period_preset: text(definition.period_preset),
    period_from: text(definition.period_from), period_to: text(definition.period_to),
    compare_mode: text(definition.compare_mode) || BLD_NONE, time_grain: text(definition.time_grain) || BLD_NONE,
    group_by_1: text(definition.group_by_1), group_by_2: text(definition.group_by_2),
    top_n: text(definition.top_n), include_other: other === true || other === 'true' ? true : (other === false || other === 'false' ? false : undefined),
    filters, chart_kind: text(definition.chart_kind), filter_field: '',
  });
}

// The create_report / update_report body: report_master columns as typed
// (list filters joined with the schema's separator).
export function bldBody(schema, draft) {
  const separator = schema.filter_rules?.list_separator ?? ';';
  const grouped = draft.group_by_1 !== '';
  const body = {
    report_name: draft.report_name, report_description: draft.report_description,
    measure: draft.measure, period_preset: draft.period_preset,
    period_from: bldNeedsDates(draft) ? draft.period_from : '', period_to: bldNeedsDates(draft) ? draft.period_to : '',
    compare_mode: draft.compare_mode, time_grain: draft.time_grain,
    group_by_1: draft.group_by_1, group_by_2: draft.group_by_2,
    top_n: grouped ? String(draft.top_n) : '', include_other: grouped ? draft.include_other === true : false,
    chart_kind: draft.chart_kind,
  };
  (schema.filters ?? []).forEach(filter => {
    const value = draft.filters[filter.key];
    body[filter.column] = filter.value_type === 'amount' ? String(value ?? '') : (value ?? []).join(separator);
  });
  return body;
}

// ── HTML ──────────────────────────────────────────────────────────────────────

function _bldChip(action, key, label, on, disabled, title = '') {
  return `<button type="button" class="rpt-chip${on ? ' on' : ''}" data-action="${action}" data-key="${esc(key)}"${disabled ? ' disabled' : ''}${title ? ` title="${esc(title)}"` : ''}>${esc(label)}</button>`;
}

function _bldError(builder, fields) {
  const error = builder.error;
  if (!error || !fields.includes(error.field)) return '';
  return `<p class="rpt-field-error" role="alert">${esc(error.message || error.error)}</p>`;
}

// ' error' on the field the server's { field } names (red border, like other forms).
function _bldErrCls(builder, field) {
  return builder.error?.field === field ? ' error' : '';
}

function _bldStep(number, title, body, extra = '') {
  return `<div class="rpt-step"><div class="rpt-step-head"><span class="rpt-step-num">${number}</span><b>${esc(title)}</b>${extra}</div>${body}</div>`;
}

function _bldOptionLabel(options, filter, value) {
  const list = options?.[BLD_OPTION_LISTS[filter.value_type]];
  return Array.isArray(list) ? (list.find(item => item.value === value)?.label ?? value) : value;
}

function _bldFilterValueControl(schema, options, filter) {
  if (!filter) return '';
  const list = options?.[BLD_OPTION_LISTS[filter.value_type]];
  if (Array.isArray(list)) {
    return `<select id="rptBFilterValue" aria-label="${esc(filter.label)} value">${list.map(item => `<option value="${esc(item.value)}">${esc(item.label)}</option>`).join('')}</select>`;
  }
  return `<input type="text" id="rptBFilterValue" aria-label="${esc(filter.label)} value" placeholder="${esc(filter.label)}">`;
}

function _bldFiltersHtml(schema, options, builder) {
  const draft = builder.draft;
  const listFilters = (schema.filters ?? []).filter(filter => filter.value_type !== 'amount');
  const amountFilters = (schema.filters ?? []).filter(filter => filter.value_type === 'amount');
  const allowedList = listFilters.filter(filter => bldFilterAllowed(schema, draft, filter.key));
  const field = allowedList.find(filter => filter.key === draft.filter_field) ?? allowedList[0] ?? null;
  const chips = listFilters.flatMap(filter => (draft.filters[filter.key] ?? []).map((value, index) =>
    `<span class="rpt-chip on">${esc(filter.label)}: ${esc(_bldOptionLabel(options, filter, value))}<button type="button" class="rpt-chip-x" data-action="rpt-b-filter-remove" data-key="${esc(filter.key)}" data-index="${index}" aria-label="Remove filter">×</button></span>`));
  const fieldSelect = `<select id="rptBFilterField" aria-label="Filter field">${listFilters.map(filter => {
    const allowed = bldFilterAllowed(schema, draft, filter.key);
    return `<option value="${esc(filter.key)}"${field?.key === filter.key ? ' selected' : ''}${allowed ? '' : ' disabled'}>${esc(filter.label)}</option>`;
  }).join('')}</select>`;
  const amounts = amountFilters.map(filter => {
    const allowed = bldFilterAllowed(schema, draft, filter.key);
    return `<div class="field${_bldErrCls(builder, filter.column)}" id="rptB_${esc(filter.column)}">
      <label for="rptBAmount_${esc(filter.key)}">${esc(filter.label)}</label>
      <input type="number" min="0" step="any" inputmode="decimal" id="rptBAmount_${esc(filter.key)}" data-filter="${esc(filter.key)}" value="${esc(draft.filters[filter.key] ?? '')}"${allowed ? '' : ' disabled'}>
    </div>`;
  }).join('');
  const columns = (schema.filters ?? []).map(filter => filter.column);
  return `
    <div class="rpt-filter-add">
      ${fieldSelect}
      ${_bldFilterValueControl(schema, options, field)}
      <button type="button" class="btn btn-secondary btn-sm" data-action="rpt-b-filter-add"${field ? '' : ' disabled'}>Add filter</button>
    </div>
    <div class="rpt-chips" style="margin-top:8px">${chips.length ? chips.join('') : '<span class="field-hint">No filters: every account, category and payee.</span>'}</div>
    ${amounts ? `<div class="form-grid" style="margin-top:10px">${amounts}</div><p class="field-hint">Amounts are in each account's own currency.</p>` : ''}
    ${_bldError(builder, columns)}`;
}

export function bldHtml(schema, options, builder) {
  const draft = builder.draft;
  const nameMax = schema.name?.max_length ?? 60;
  const descMax = schema.description?.max_length ?? 140;
  const groups = _bldGroups(draft);
  const maxGroups = schema.group_by_rules?.max ?? 2;

  const name = `
    <div class="form-grid">
      <div class="field${_bldErrCls(builder, 'report_name')}" id="rptB_report_name">
        <label for="rptBName">Report name *</label>
        <input type="text" id="rptBName" maxlength="${nameMax}" value="${esc(draft.report_name)}" placeholder="e.g. Monthly spend by category">
        <span class="field-hint" id="rptBNameCount">${esc(String(draft.report_name.length))} / ${nameMax}</span>
      </div>
      <div class="field${_bldErrCls(builder, 'report_description')}" id="rptB_report_description">
        <label for="rptBDescription">Description (optional)</label>
        <input type="text" id="rptBDescription" maxlength="${descMax}" value="${esc(draft.report_description)}" placeholder="What this report answers">
        <span class="field-hint" id="rptBDescriptionCount">${esc(String(draft.report_description.length))} / ${descMax}</span>
      </div>
    </div>
    ${_bldError(builder, ['report_name', 'report_description'])}`;

  const measure = `<div class="rpt-chips">${(schema.measures ?? []).map(item => _bldChip('rpt-b-measure', item.key, item.label, item.key === draft.measure, false)).join('')}</div>
    ${_bldError(builder, ['measure'])}`;

  const period = `
    <div class="form-grid">
      <div class="field${_bldErrCls(builder, 'period_preset')}" id="rptB_period_preset">
        <label for="rptBPeriod">Period</label>
        <select id="rptBPeriod">${(schema.period_presets ?? []).map(item => `<option value="${esc(item.key)}"${item.key === draft.period_preset ? ' selected' : ''}>${esc(item.label)}</option>`).join('')}</select>
      </div>
      ${bldNeedsDates(draft) ? `
      <div class="field${_bldErrCls(builder, 'period_from')}" id="rptB_period_from"><label for="rptBFrom">From (UTC date)</label><input type="date" id="rptBFrom" value="${esc(draft.period_from)}"></div>
      <div class="field${_bldErrCls(builder, 'period_to')}" id="rptB_period_to"><label for="rptBTo">To (UTC date)</label><input type="date" id="rptBTo" value="${esc(draft.period_to)}"></div>` : ''}
      <div class="field${_bldErrCls(builder, 'compare_mode')}" id="rptB_compare_mode">
        <label for="rptBCompare">Compare with</label>
        <select id="rptBCompare">${(schema.compare_modes ?? []).map(item => `<option value="${esc(item.key)}"${item.key === draft.compare_mode ? ' selected' : ''}${bldCompareAllowed(schema, draft, item.key) ? '' : ' disabled'}>${esc(item.label)}</option>`).join('')}</select>
      </div>
    </div>
    <div class="field" id="rptB_time_grain" style="margin-top:10px">
      <label>Time steps</label>
      <div class="rpt-chips">${(schema.time_grains ?? []).map(item => _bldChip('rpt-b-grain', item.key, item.label, item.key === draft.time_grain, false)).join('')}</div>
    </div>
    ${_bldError(builder, ['period_preset', 'period_from', 'period_to', 'compare_mode', 'time_grain'])}`;

  const topN = groups.length === 0 ? '' : `
    <div class="form-grid" style="margin-top:10px">
      <div class="field${_bldErrCls(builder, 'top_n')}" id="rptB_top_n">
        <label for="rptBTopN">Show the top</label>
        <select id="rptBTopN">${(schema.group_by_rules?.top_n_values ?? []).map(value => `<option value="${esc(String(value))}"${String(value) === String(draft.top_n) ? ' selected' : ''}>${esc(String(value))}</option>`).join('')}</select>
      </div>
      <div class="field" id="rptB_include_other">
        <label class="rpt-check"><input type="checkbox" id="rptBOther"${draft.include_other === true ? ' checked' : ''}> Group the rest as Other</label>
      </div>
    </div>`;
  const breakdown = `<div class="rpt-chips">${(schema.group_by ?? []).map(item => {
    const on = groups.includes(item.key);
    const allowed = bldGroupAllowed(schema, draft, item.key) && (on || groups.length < maxGroups);
    return _bldChip('rpt-b-group', item.key, on && groups.length > 1 ? `${groups.indexOf(item.key) + 1}. ${item.label}` : item.label, on, !allowed);
  }).join('')}</div>${topN}
    ${_bldError(builder, ['group_by_1', 'group_by_2', 'top_n', 'include_other'])}`;

  const chart = `<div class="rpt-chips" id="rptB_chart_kind">${(schema.chart_kinds ?? []).map(item =>
    _bldChip('rpt-b-chart', item.key, item.label, item.key === draft.chart_kind, !bldChartFits(schema, draft, item))).join('')}</div>
    ${(schema.chart_kinds ?? []).some(item => item.key === draft.chart_kind && item.home_slot === 'tile') ? '<p class="field-hint">A single number can sit in a Home tile.</p>' : ''}
    ${_bldError(builder, ['chart_kind'])}`;

  const known = ['report_name', 'report_description', 'measure', 'period_preset', 'period_from', 'period_to', 'compare_mode', 'time_grain',
    'group_by_1', 'group_by_2', 'top_n', 'include_other', 'chart_kind', ...(schema.filters ?? []).map(filter => filter.column)];
  const general = builder.error && !known.includes(builder.error.field) ? `<p class="rpt-field-error" role="alert">${esc(builder.error.message || builder.error.error)}</p>` : '';

  return `
    <div class="card rpt-builder">
      <div class="rpt-builder-head">
        <div class="rpt-eyebrow">${builder.mode === 'edit' ? 'Edit report' : 'New report'}</div>
        <button type="button" class="btn btn-secondary btn-sm" data-action="rpt-b-cancel" aria-label="Close builder">×</button>
      </div>
      ${_bldStep(1, 'Name it', name)}
      ${_bldStep(2, 'What to measure', measure)}
      ${_bldStep(3, 'Period and time steps', period)}
      ${_bldStep(4, 'Break down by', breakdown, `<span class="field-hint"> up to ${esc(String(maxGroups))}</span>`)}
      ${_bldStep(5, 'Filters', _bldFiltersHtml(schema, options, builder), '<span class="field-hint"> optional</span>')}
      ${_bldStep(6, 'Show as', chart)}
      ${general}
      <div class="form-actions" style="justify-content:flex-end">
        <button type="button" class="btn btn-secondary" data-action="rpt-b-cancel">Cancel</button>
        <button type="button" class="btn btn-primary" data-action="rpt-b-save">Save report</button>
      </div>
      <p class="field-hint" style="text-align:right">Reports are computed by the next refresh; until then they show as Queued.</p>
    </div>`;
}

// ── Events ────────────────────────────────────────────────────────────────────

// Renders the builder into container and binds its events. ctx:
// { schema, options, builder (state.reportBuilder), onSave(), onClose() }.
// Choice changes re-render the builder; typing only updates the draft (and the
// counters) so focus is kept.
export function renderBuilder(container, ctx) {
  if (!container) return;
  const { schema, options, builder } = ctx;
  container.innerHTML = bldHtml(schema, options, builder);
  if (container._bldAbort) container._bldAbort.abort();
  const abort = new AbortController();
  container._bldAbort = abort;
  const draft = builder.draft;
  const rerender = () => { bldNormalise(schema, draft); renderBuilder(container, ctx); };

  container.addEventListener('input', e => {
    const target = e.target;
    if (target.id === 'rptBName') {
      draft.report_name = target.value;
      const counter = container.querySelector('#rptBNameCount');
      if (counter) counter.textContent = `${target.value.length} / ${schema.name?.max_length ?? 60}`;
    } else if (target.id === 'rptBDescription') {
      draft.report_description = target.value;
      const counter = container.querySelector('#rptBDescriptionCount');
      if (counter) counter.textContent = `${target.value.length} / ${schema.description?.max_length ?? 140}`;
    } else if (target.dataset?.filter) {
      draft.filters[target.dataset.filter] = target.value;
    } else if (target.id === 'rptBFrom') draft.period_from = target.value;
    else if (target.id === 'rptBTo') draft.period_to = target.value;
  }, { signal: abort.signal });

  container.addEventListener('change', e => {
    const target = e.target;
    if (target.id === 'rptBPeriod') { draft.period_preset = target.value; rerender(); }
    else if (target.id === 'rptBCompare') { draft.compare_mode = target.value; rerender(); }
    else if (target.id === 'rptBTopN') draft.top_n = target.value;
    else if (target.id === 'rptBOther') draft.include_other = target.checked === true;
    else if (target.id === 'rptBFilterField') { draft.filter_field = target.value; rerender(); }
  }, { signal: abort.signal });

  container.addEventListener('click', e => {
    const button = e.target.closest('[data-action]');
    if (!button || button.disabled) return;
    const { action, key } = button.dataset;
    if (action === 'rpt-b-measure') { draft.measure = key; rerender(); }
    else if (action === 'rpt-b-grain') { draft.time_grain = key; rerender(); }
    else if (action === 'rpt-b-chart') { draft.chart_kind = key; rerender(); }
    else if (action === 'rpt-b-group') {
      const groups = _bldGroups(draft);
      const next = groups.includes(key) ? groups.filter(item => item !== key) : [...groups, key];
      draft.group_by_1 = next[0] ?? '';
      draft.group_by_2 = next[1] ?? '';
      rerender();
    } else if (action === 'rpt-b-filter-add') {
      const fieldKey = container.querySelector('#rptBFilterField')?.value ?? '';
      const value = String(container.querySelector('#rptBFilterValue')?.value ?? '').trim();
      if (fieldKey === '' || value === '') return;
      const values = draft.filters[fieldKey] ?? [];
      if (!values.includes(value)) draft.filters[fieldKey] = [...values, value];
      draft.filter_field = fieldKey;
      rerender();
    } else if (action === 'rpt-b-filter-remove') {
      draft.filters[key] = (draft.filters[key] ?? []).filter((_, index) => index !== Number(button.dataset.index));
      rerender();
    } else if (action === 'rpt-b-save') ctx.onSave?.();
    else if (action === 'rpt-b-cancel') ctx.onClose?.();
  }, { signal: abort.signal });
}
