// =============================================================================
// FULCRUM FORGE — Report Validation: one report definition, before any write
//
// Rules come from REPORT_DEFINITION (report-contract.gs). ledger-database-load
// and the analytics job validate again with the same contract file.
// validateReportDefinition(body, refs) → { ok:true, values:{ column: value } }
//   or { ok:false, error, field }. values are normalised and ready to store:
//   lists joined with ';', top_n a number or '', include_other a boolean.
// refs: { account_ids: {id:true}, categories: {'major' | 'major|minor': true},
//         currencies: {CODE:true} } from the current Sheet (rptReferences()),
//   or null to check the format only (CSV dry runs never read a Sheet).
// =============================================================================

const _RPT_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const _RPT_AMOUNT = /^\d+(?:\.\d+)?$/;
const _RPT_CURRENCY = /^[A-Z0-9]{1,8}$/;
const _RPT_TEXT_VALUE_MAX = 100;

function _rptText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function _rptFail(error, field) {
  return { ok: false, error: error, field: field };
}

// YYYY-MM-DD that is a real calendar date → epoch day number, else null.
function _rptDay(text) {
  const parts = _RPT_DATE.exec(text);
  if (parts === null) return null;
  const time = Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
  const date = new Date(time);
  if (date.getUTCFullYear() !== Number(parts[1]) || date.getUTCMonth() !== Number(parts[2]) - 1 || date.getUTCDate() !== Number(parts[3])) return null;
  return time / 86400000;
}

function _rptBoolean(value, fallback) {
  if (value === true || value === false) return value;
  const text = _rptText(value).toLowerCase();
  if (text === '') return fallback;
  if (text === 'true') return true;
  if (text === 'false') return false;
  return null;
}

// ;-separated list → trimmed, non-empty, without duplicates (by key).
function _rptList(value, keyOf) {
  const seen = {};
  const out = [];
  _rptText(value).split(REPORT_DEFINITION.filter_rules.list_separator).forEach(function(part) {
    const item = part.trim();
    if (item === '') return;
    const key = keyOf(item);
    if (seen[key] === true) return;
    seen[key] = true;
    out.push(item);
  });
  return out;
}

function _rptFilterValues(filter, raw, refs) {
  const field = filter.column;
  if (filter.value_type === 'amount') {
    const text = _rptText(raw);
    if (text === '') return { ok: true, value: '' };
    if (!_RPT_AMOUNT.test(text)) return _rptFail('invalid_filter_value', field);
    return { ok: true, value: text };
  }
  const caseInsensitive = filter.value_type === 'text_list' || filter.value_type === 'uuid_list' || filter.value_type === 'currency_list';
  const values = _rptList(raw, function(item) { return caseInsensitive ? item.toLowerCase() : item; });
  if (values.length > filter.max_values) return _rptFail('too_many_filter_values', field);
  const out = [];
  for (let index = 0; index < values.length; index++) {
    const item = values[index];
    if (filter.value_type === 'uuid_list') {
      const id = item.toLowerCase();
      if (!isAccountUuid(id)) return _rptFail('invalid_filter_value', field);
      if (refs !== null && refs.account_ids[id] !== true) return _rptFail('unknown_filter_reference', field);
      out.push(id);
    } else if (filter.value_type === 'category_list') {
      const parts = item.split('|').map(function(part) { return part.trim(); });
      if (parts.length > 2 || parts.some(function(part) { return part === ''; })) return _rptFail('invalid_filter_value', field);
      const key = parts.join('|');
      if (refs !== null && refs.categories[key] !== true) return _rptFail('unknown_filter_reference', field);
      out.push(key);
    } else if (filter.value_type === 'currency_list') {
      const code = item.toUpperCase();
      if (!_RPT_CURRENCY.test(code)) return _rptFail('invalid_filter_value', field);
      if (refs !== null && refs.currencies[code] !== true) return _rptFail('unknown_filter_reference', field);
      out.push(code);
    } else if (filter.value_type === 'tx_type_list') {
      if (filter.values.indexOf(item) === -1) return _rptFail('invalid_filter_value', field);
      out.push(item);
    } else {
      if (item.length > _RPT_TEXT_VALUE_MAX || item.indexOf(REPORT_DEFINITION.filter_rules.list_separator) !== -1) return _rptFail('invalid_filter_value', field);
      out.push(item);
    }
  }
  return { ok: true, value: out.join(REPORT_DEFINITION.filter_rules.list_separator) };
}

function _rptChartFits(chart, measure, grain, groupCount) {
  const measureOk = chart.measures === 'all' || (chart.measures === 'additive' && measure.additive === true)
    || (Array.isArray(chart.measures) && chart.measures.indexOf(measure.key) !== -1);
  if (!measureOk) return 'chart_not_allowed_for_measure';
  const shapeOk = chart.modes.some(function(mode) {
    const grainOk = mode.time_grain === 'any' || (mode.time_grain === 'required') === (grain !== 'none');
    return grainOk && groupCount >= mode.group_by_min && groupCount <= mode.group_by_max;
  });
  return shapeOk ? '' : 'chart_not_allowed_for_shape';
}

function validateReportDefinition(body, refs) {
  const def = REPORT_DEFINITION;
  const values = {};
  const input = body === undefined || body === null ? {} : body;

  const name = _rptText(input.report_name);
  if (name === '') return _rptFail('missing_report_name', 'report_name');
  if (name.length < def.name.min_length) return _rptFail('report_name_too_short', 'report_name');
  if (name.length > def.name.max_length) return _rptFail('report_name_too_long', 'report_name');
  values.report_name = name;
  const description = _rptText(input.report_description);
  if (description.length > def.description.max_length) return _rptFail('report_description_too_long', 'report_description');
  values.report_description = description;

  const measure = rptChoice(def.measures, input.measure);
  if (measure === null) return _rptFail('invalid_measure', 'measure');
  values.measure = measure.key;

  const preset = rptChoice(def.period_presets, input.period_preset);
  if (preset === null) return _rptFail('invalid_period_preset', 'period_preset');
  values.period_preset = preset.key;
  const fromText = _rptText(input.period_from), toText = _rptText(input.period_to);
  let spanDays = preset.max_days;
  if (preset.key === 'fixed') {
    const from = _rptDay(fromText), to = _rptDay(toText);
    if (from === null) return _rptFail('invalid_period_dates', 'period_from');
    if (to === null || to < from) return _rptFail('invalid_period_dates', 'period_to');
    spanDays = to - from + 1;
    if (spanDays > def.limits.fixed_period_max_days) return _rptFail('fixed_period_too_long', 'period_to');
  } else if (fromText !== '' || toText !== '') {
    return _rptFail('period_dates_not_allowed', fromText !== '' ? 'period_from' : 'period_to');
  }
  values.period_from = preset.key === 'fixed' ? fromText : '';
  values.period_to = preset.key === 'fixed' ? toText : '';

  const compare = _rptText(input.compare_mode) === '' ? rptChoice(def.compare_modes, 'none') : rptChoice(def.compare_modes, input.compare_mode);
  if (compare === null) return _rptFail('invalid_compare_mode', 'compare_mode');
  if (compare.key !== 'none' && def.compare_rules.not_with_periods.indexOf(preset.key) !== -1) return _rptFail('compare_not_allowed', 'compare_mode');
  values.compare_mode = compare.key;

  const grain = _rptText(input.time_grain) === '' ? rptChoice(def.time_grains, 'none') : rptChoice(def.time_grains, input.time_grain);
  if (grain === null) return _rptFail('invalid_time_grain', 'time_grain');
  values.time_grain = grain.key;

  const groupKeys = [_rptText(input.group_by_1), _rptText(input.group_by_2)];
  if (groupKeys[0] === '' && groupKeys[1] !== '') return _rptFail('group_by_order', 'group_by_2');
  for (let index = 0; index < 2; index++) {
    const field = 'group_by_' + (index + 1);
    if (groupKeys[index] === '') continue;
    if (rptChoice(def.group_by, groupKeys[index]) === null) return _rptFail('invalid_group_by', field);
    if (measure.group_by !== 'all' && measure.group_by.indexOf(groupKeys[index]) === -1) return _rptFail('group_by_not_allowed_for_measure', field);
  }
  if (groupKeys[1] !== '' && groupKeys[0] === groupKeys[1]) return _rptFail('duplicate_group_by', 'group_by_2');
  values.group_by_1 = groupKeys[0];
  values.group_by_2 = groupKeys[1];
  const groupCount = groupKeys.filter(function(key) { return key !== ''; }).length;

  const topText = _rptText(input.top_n);
  const includeOther = _rptBoolean(input.include_other, groupCount > 0 ? def.group_by_rules.include_other_default : false);
  if (includeOther === null) return _rptFail('invalid_include_other', 'include_other');
  if (groupCount === 0) {
    if (topText !== '') return _rptFail('top_n_without_group_by', 'top_n');
    if (includeOther === true) return _rptFail('top_n_without_group_by', 'include_other');
    values.top_n = '';
    values.include_other = false;
  } else {
    const top = topText === '' ? def.group_by_rules.top_n_default : Number(topText);
    if (!/^\d*$/.test(topText) || def.group_by_rules.top_n_values.indexOf(top) === -1) return _rptFail('invalid_top_n', 'top_n');
    values.top_n = top;
    values.include_other = includeOther;
  }

  let amountMin = '', amountMax = '';
  for (let index = 0; index < def.filters.length; index++) {
    const filter = def.filters[index];
    const parsed = _rptFilterValues(filter, input[filter.column], refs);
    if (parsed.ok === false) return parsed;
    if (parsed.value !== '' && measure.kind === 'stock' && def.filter_rules.transaction_only.indexOf(filter.key) !== -1)
      return _rptFail('filter_not_allowed_for_measure', filter.column);
    values[filter.column] = parsed.value;
    if (filter.key === 'amount_min') amountMin = parsed.value;
    if (filter.key === 'amount_max') amountMax = parsed.value;
  }
  if (amountMin !== '' && amountMax !== '' && Number(amountMin) > Number(amountMax)) return _rptFail('invalid_amount_range', 'filter_amount_max');

  const chart = rptChoice(def.chart_kinds, input.chart_kind);
  if (chart === null) return _rptFail('invalid_chart_kind', 'chart_kind');
  const chartError = _rptChartFits(chart, measure, grain.key, groupCount);
  if (chartError !== '') return _rptFail(chartError, 'chart_kind');
  values.chart_kind = chart.key;

  // 'all' has no fixed length: the job checks its point count.
  if (grain.key !== 'none' && spanDays !== null && Math.ceil(spanDays / def.time_grain_days[grain.key]) > def.limits.max_points)
    return _rptFail('too_many_points', 'time_grain');

  return { ok: true, values: values };
}
