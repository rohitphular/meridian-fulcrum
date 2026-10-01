// =============================================================================
// FULCRUM FORGE — Insights: categories and tags (server compute for get_insight)
//
// Reference port (P4-A): 10-top-categories. See insights-registry.gs for ictx,
// helpers and the payload schema.
// Globals in this file use the _insCat prefix (compute hooks insightCompute_*).
// =============================================================================

const _INS_CAT_TOP_N = 10;

// Top minor categories by spend in the period vs the compare range
// (ictx.compare: previous period by default; compare=last_year|none).
// Categories are grouped by major+minor key (the old client merged equal minor
// keys across majors); labels come from the category catalog.
function insightCompute_10_top_categories(ictx) {
  const period = ictx.period;
  const current = insFlows(ictx, { kind: 'spend' });
  if (current.length === 0) return insEmpty('No spending data for this period.');
  const compare = ictx.compare;
  const previous = compare === null ? [] : insFlows(ictx, { kind: 'spend', from: compare.from, to: compare.to });

  const groupsA = insByMinor(current);
  const totalsB = Object.create(null);
  insByMinor(previous).forEach(function(group) { totalsB[group.key] = group; });
  // Union of categories ranked by the current period (then by the previous).
  const rows = groupsA.map(function(group) {
    return { key: group.key, label: group.label, current: group.total, previous: totalsB[group.key] === undefined ? 0 : totalsB[group.key].total };
  });
  Object.keys(totalsB).forEach(function(key) {
    if (!groupsA.some(function(group) { return group.key === key; })) rows.push({ key: key, label: totalsB[key].label, current: 0, previous: totalsB[key].total });
  });
  rows.sort(function(a, b) { return b.current - a.current || b.previous - a.previous || a.label.localeCompare(b.label); });
  const top = rows.slice(0, _INS_CAT_TOP_N);

  const labelA = insRangeLabel(period.from === null ? insFirstFlowDate(ictx, 'spend') : period.from, period.to);
  const labelB = compare === null ? null : compare.label;
  const totalA = top.reduce(function(sum, row) { return sum + row.current; }, 0);
  const totalB = top.reduce(function(sum, row) { return sum + row.previous; }, 0);

  const statCards = [insStat('current', labelA, totalA, 'money', 'top ' + top.length + ' categories')];
  if (labelB !== null) statCards.push(insStat('previous', labelB, totalB, 'money', 'same categories'));

  const datasets = [{ key: 'current', label: labelA, data: top.map(function(row) { return row.current; }), style: 'primary' }];
  if (labelB !== null) datasets.push({ key: 'previous', label: labelB, data: top.map(function(row) { return row.previous; }), style: 'compare' });

  const tables = [];
  if (labelB !== null) {
    tables.push({
      id: 'deltas', title: 'Change vs ' + labelB,
      columns: [
        { key: 'category', label: 'Category', format: 'text', align: 'left' },
        { key: 'delta', label: 'Change', format: 'money_delta', align: 'right' },
      ],
      // More spend than before is shown as negative (red), less as positive.
      rows: top.map(function(row) {
        const delta = row.current - row.previous;
        return { key: row.key, cells: { category: row.label, delta: delta }, tone: delta <= 0 ? 'positive' : 'negative' };
      }),
      sortable: [], sort: null,
    });
  }

  return {
    stat_cards: statCards,
    charts: [{
      id: 'top', kind: 'hbar', height: Math.max(200, top.length * 32),
      labels: top.map(function(row) { return row.label; }), datasets: datasets,
      y_format: 'money', ref_lines: [],
    }],
    tables: tables,
  };
}

// ── P4-C: 08, 09, 11, 12, 13 ──────────────────────────────────────────────────
// All five read spend through insFlows (no deleted rows, no own-account
// transfers, quote currency, period ends today) and group by the resolved
// category key with catalog labels (the old client grouped and displayed raw
// sheet keys). Tags are split equally between a transaction's distinct tags.

const _INS_CAT_MAX_SEGMENTS = 7;   // donut segments before the rest merge into "Other"
const _INS_CAT_TOP_MINORS = 10;
const _INS_CAT_VISIBLE_TAGS = 6;   // 13: tag lines shown; the rest start hidden
const _INS_CAT_OTHER_KEY = '__other__';
const _INS_CAT_NONE_KEY = '(none)';

function _insCatPct(part, total) {
  return total > 0 ? part / total * 100 : 0;
}

// Period start, or the first spend date inside the range when the period has
// none (custom range without a start); null when there is no spend at all.
function _insCatFrom(ictx, spend) {
  if (ictx.period.from !== null) return ictx.period.from;
  return spend.reduce(function(first, row) { return first === null || row.date_key < first ? row.date_key : first; }, null);
}

// Catalog label of a major key (any money-out category carrying it), so a row
// whose minor is blank or unknown still shows 'Food', not the raw key.
function _insCatMajorLabel(ictx, key, fallback) {
  const match = insIndex(ictx).categories.find(function(c) {
    return _insText(c.tx_type_key) === 'money-out' && _insText(c.major_category_key) === key && _insText(c.major_category_label) !== '';
  });
  return match === undefined ? fallback : _insText(match.major_category_label);
}

// insByMajor with catalog labels for every group.
function _insCatMajors(ictx, rows) {
  const groups = insByMajor(rows);
  groups.forEach(function(group) {
    if (group.key !== _INS_CAT_NONE_KEY) group.label = _insCatMajorLabel(ictx, group.key, group.label);
  });
  return groups;
}

// Minor groups inside one major: key = minor key ('(none)' when blank),
// label = catalog minor label ('Other' when blank, as the old drilldown showed).
function _insCatMinors(rows) {
  return insGroupBy(rows, function(row) { return row.category.minor_key === '' ? _INS_CAT_NONE_KEY : row.category.minor_key; },
    function(row) { return row.category.minor_key === '' ? 'Other' : row.category.minor_label; });
}

// Top segments, the rest merged into one 'Other' group (only when that merges
// at least two groups, as the old donuts did). Each segment keeps its rows.
function _insCatSegments(groups, otherLabel, amountKey) {
  if (groups.length <= _INS_CAT_MAX_SEGMENTS + 1) return groups.slice();
  const rest = groups.slice(_INS_CAT_MAX_SEGMENTS);
  const other = { key: _INS_CAT_OTHER_KEY, label: otherLabel, total: 0, count: 0, rows: [], members: rest.map(function(g) { return g.key; }) };
  rest.forEach(function(group) {
    other.total += group[amountKey];
    other.count += group.count;
    other.rows = other.rows.concat(group.rows);
  });
  if (amountKey !== 'total') other[amountKey] = other.total;
  return groups.slice(0, _INS_CAT_MAX_SEGMENTS).concat([other]);
}

// list_transactions_view pointer for a set of major keys (null for uncategorised).
function _insCatMajorQuery(ictx, from, majorKeys, minorKey) {
  if (majorKeys.indexOf(_INS_CAT_NONE_KEY) !== -1) return null;
  const extra = { types: 'money-out', major: majorKeys.join(',') };
  if (minorKey !== undefined && minorKey !== null && minorKey !== _INS_CAT_NONE_KEY) extra.minor = minorKey;
  return insTxQuery(from, ictx.period.to, extra);
}

// ── 08-category-pie ───────────────────────────────────────────────────────────

// Donut of spend by major category (top 7 + Other), a segment table (the old
// legend: amount + share), the top 10 major → minor categories, and a
// per-segment transaction panel (drill { major: key | '__other__' }).
function insightCompute_08_category_pie(ictx) {
  const spend = insFlows(ictx, { kind: 'spend' });
  const drillMajor = insDrillValue(ictx, 'major');
  if (spend.length === 0) {
    if (ictx.drill !== null) return insError('invalid_drill', 'drill');
    return insEmpty('No spending data for this period.');
  }
  const from = _insCatFrom(ictx, spend);
  const majors = _insCatMajors(ictx, spend);
  const segments = _insCatSegments(majors, 'Other', 'total');
  const total = insTotal(spend);

  let drillSegment = null;
  if (ictx.drill !== null) {
    drillSegment = drillMajor === null ? null : segments.find(function(seg) { return seg.key === drillMajor; });
    if (drillSegment === undefined || drillSegment === null) {
      // A major merged into 'Other' can still be drilled on its own.
      drillSegment = drillMajor === null ? null : majors.find(function(group) { return group.key === drillMajor; });
      if (drillSegment === undefined || drillSegment === null) return insError('invalid_drill', 'drill');
    }
  }

  const minorRows = insGroupBy(spend, function(row) {
    return (row.category.major_key === '' ? _INS_CAT_NONE_KEY : row.category.major_key) + '|' + (row.category.minor_key === '' ? _INS_CAT_NONE_KEY : row.category.minor_key);
  }, function(row) {
    if (row.category.major_key === '') return 'Uncategorised';
    const major = _insCatMajorLabel(ictx, row.category.major_key, row.category.major_label);
    return major + ' → ' + (row.category.minor_key === '' ? '—' : row.category.minor_label);
  }).slice(0, _INS_CAT_TOP_MINORS);

  const shareColumns = function(first) {
    return [
      { key: 'category', label: first, format: 'text', align: 'left' },
      { key: 'amount', label: 'Amount', format: 'money', align: 'right' },
      { key: 'share', label: '%', format: 'percent', align: 'right' },
    ];
  };

  const payload = {
    stat_cards: [
      insStat('total', 'Total spend', total, 'money', spend.length + ' expense' + (spend.length === 1 ? '' : 's')),
      insStat('categories', 'Categories', majors.length, 'count', 'tap a segment to see transactions'),
      insStat('top', 'Largest category', majors[0].total, 'money', majors[0].label),
    ],
    charts: [{
      id: 'categories', kind: 'donut', labels: segments.map(function(seg) { return seg.label; }),
      datasets: [{ key: 'spend', label: 'Spend', data: segments.map(function(seg) { return seg.total; }), style: 'palette' }],
      y_format: 'money', ref_lines: [],
      drill: { param: 'major', values: segments.map(function(seg) { return seg.key; }), mode: 'panel', hint: 'Tap a segment to see its transactions' },
    }],
    tables: [
      {
        id: 'segments', title: 'Categories', columns: shareColumns('Category'),
        rows: segments.map(function(seg) {
          return { key: seg.key, cells: { category: seg.label, amount: seg.total, share: _insCatPct(seg.total, total) }, drill: { param: 'major', value: seg.key, mode: 'panel' } };
        }),
        sortable: [], sort: null,
      },
      {
        id: 'minors', title: 'Top minor categories', columns: shareColumns('Category'),
        rows: minorRows.map(function(group) {
          return { key: group.key, cells: { category: group.label, amount: group.total, share: _insCatPct(group.total, total) } };
        }),
        sortable: [], sort: null,
      },
    ],
    drill: null,
  };
  if (drillSegment !== null) {
    const keys = drillSegment.key === _INS_CAT_OTHER_KEY ? drillSegment.members : [drillSegment.key];
    payload.drill = insDrill(ictx, drillSegment.label, drillSegment.rows, _insCatMajorQuery(ictx, from, keys));
  }
  return payload;
}

// ── 09-category-trend ─────────────────────────────────────────────────────────

// Stacked monthly spend by major category (largest category first = bottom of
// the stack) with total / top category / peak month / category count.
function insightCompute_09_category_trend(ictx) {
  const spend = insFlows(ictx, { kind: 'spend' });
  if (spend.length === 0) return insEmpty('No spending data for this period.');
  const from = _insCatFrom(ictx, spend);
  const months = ldgMonthKeys(from, ictx.period.to);
  const majors = _insCatMajors(ictx, spend);
  const datasets = majors.map(function(group, i) {
    const series = insMonthlySeries(group.rows, from, ictx.period.to);
    return { key: group.key, label: group.label, data: series.values, style: 'palette:' + i };
  });
  const monthTotals = insMonthlySeries(spend, from, ictx.period.to).values;
  const peak = Math.max.apply(null, monthTotals);
  const peakIndex = monthTotals.indexOf(peak);

  return {
    stat_cards: [
      insStat('total', 'Total spend', insTotal(spend), 'money'),
      insStat('top', 'Top category', majors[0].total, 'money', majors[0].label),
      insStat('peak', 'Peak month', peak, 'money', insMonthLabel(months[peakIndex])),
      insStat('categories', 'Categories', majors.length, 'count'),
    ],
    charts: [{
      id: 'trend', kind: 'stacked', labels: months.map(insMonthLabel), datasets: datasets,
      y_format: 'money', y_min: 0, ref_lines: [],
    }],
  };
}

// ── 11-category-drilldown ─────────────────────────────────────────────────────

// Three levels, all on the server: majors → minors of one major → the
// transactions of one minor. Drill state is the get_insight drill param:
//   {}                                  level 1
//   { major: 'food' }                   level 2
//   { minor: 'food|groceries' }         level 3 (chart click: one value carries the path)
//   { major: 'food', minor: 'groceries' } level 3 (equivalent)
// A major without spend in the period → invalid_drill (the client drops it and
// reloads level 1); a minor without spend falls back to its major (as before).
function insightCompute_11_category_drilldown(ictx) {
  const spend = insFlows(ictx, { kind: 'spend' });
  let majorKey = insDrillValue(ictx, 'major');
  let minorKey = insDrillValue(ictx, 'minor');
  if (minorKey !== null && minorKey.indexOf('|') !== -1) {
    const cut = minorKey.indexOf('|');
    if (majorKey !== null && majorKey !== minorKey.slice(0, cut)) return insError('invalid_drill', 'drill');
    majorKey = minorKey.slice(0, cut);
    minorKey = minorKey.slice(cut + 1);
  }
  if (ictx.drill !== null && majorKey === null) return insError('invalid_drill', 'drill');
  if (spend.length === 0) {
    if (ictx.drill !== null) return insError('invalid_drill', 'drill');
    return insEmpty('No spending data for this period.');
  }
  const from = _insCatFrom(ictx, spend);
  const majors = _insCatMajors(ictx, spend);
  const root = { label: 'All categories', drill: null };

  if (majorKey === null) {
    return {
      stat_cards: [
        insStat('total', 'Total spend', insTotal(spend), 'money'),
        insStat('categories', 'Categories', majors.length, 'count', 'tap a bar to drill in'),
      ],
      charts: [{
        id: 'majors', kind: 'hbar', height: Math.max(120, majors.length * 36 + 40),
        labels: majors.map(function(group) { return group.label; }),
        datasets: [{ key: 'spend', label: 'Spend', data: majors.map(function(group) { return group.total; }), style: 'palette' }],
        y_format: 'money', ref_lines: [],
        drill: { param: 'major', values: majors.map(function(group) { return group.key; }), mode: 'replace', hint: 'Tap a bar to see its sub-categories' },
      }],
      breadcrumbs: [root],
    };
  }

  const majorIndex = majors.findIndex(function(group) { return group.key === majorKey; });
  if (majorIndex === -1) return insError('invalid_drill', 'drill');
  const major = majors[majorIndex];
  const minors = _insCatMinors(major.rows);
  const minor = minorKey === null ? null : minors.find(function(group) { return group.key === minorKey; });
  const majorCrumb = { label: major.label, drill: { major: major.key } };

  if (minor === null || minor === undefined) {
    if (minorKey !== null) console.log('insightCompute_11: minor not in period, showing major level');
    return {
      stat_cards: [
        insStat('total', 'Total (' + major.label + ')', major.total, 'money'),
        insStat('minors', 'Sub-categories', minors.length, 'count', 'tap a bar to see transactions'),
      ],
      charts: [{
        id: 'minors', kind: 'hbar', title: major.label + ' — minor breakdown', height: Math.max(120, minors.length * 36 + 40),
        labels: minors.map(function(group) { return group.label; }),
        datasets: [{ key: 'spend', label: major.label, data: minors.map(function(group) { return group.total; }), style: 'palette:' + majorIndex }],
        y_format: 'money', ref_lines: [],
        drill: { param: 'minor', values: minors.map(function(group) { return major.key + '|' + group.key; }), mode: 'replace', hint: 'Tap a bar to see its transactions' },
      }],
      breadcrumbs: [root, majorCrumb],
    };
  }

  return {
    stat_cards: [
      insStat('total', 'Total', minor.total, 'money', null, 'negative'),
      insStat('count', 'Transactions', minor.count, 'count'),
    ],
    drill: insDrill(ictx, major.label + ' › ' + minor.label, minor.rows, _insCatMajorQuery(ictx, from, [major.key], minor.key)),
    breadcrumbs: [root, majorCrumb, { label: minor.label, drill: { major: major.key, minor: minor.key } }],
  };
}

// ── Tags (12, 13) ─────────────────────────────────────────────────────────────

// Distinct tags of a flow row (trimmed, lower-cased, duplicates dropped).
function _insCatRowTags(row) {
  const seen = Object.create(null);
  const out = [];
  _insText(row.tx.tx_tags).split(';').forEach(function(raw) {
    const tag = raw.trim().toLowerCase();
    if (tag === '' || seen[tag] === true) return;
    seen[tag] = true;
    out.push(tag);
  });
  return out;
}

// Split attribution: each distinct tag gets quote / tag count (a £90 row
// tagged a;b;c adds £30 to each). Returns [{ key, label, amount, count, rows,
// shared }] by amount desc, then tag; count = transactions carrying the tag.
function _insCatTagGroups(rows) {
  const groups = Object.create(null);
  const order = [];
  rows.forEach(function(row) {
    const tags = _insCatRowTags(row);
    tags.forEach(function(tag) {
      if (groups[tag] === undefined) { groups[tag] = { key: tag, label: tag, amount: 0, total: 0, count: 0, rows: [], shared: 0 }; order.push(tag); }
      const group = groups[tag];
      group.amount += row.quote / tags.length;
      group.count += 1;
      group.rows.push(row);
      if (tags.length > 1) group.shared += 1;
    });
  });
  return order.map(function(tag) { groups[tag].total = groups[tag].amount; return groups[tag]; }).sort(function(a, b) {
    return b.amount - a.amount || a.label.localeCompare(b.label);
  });
}

// Split share of rows attributed to one tag.
function _insCatTagShare(rows, tag) {
  return rows.reduce(function(sum, row) {
    const tags = _insCatRowTags(row);
    return tags.indexOf(tag) === -1 ? sum : sum + row.quote / tags.length;
  }, 0);
}

// { tagged, untagged } flow rows.
function _insCatTagSplit(spend) {
  const tagged = [], untagged = [];
  spend.forEach(function(row) { (_insCatRowTags(row).length > 0 ? tagged : untagged).push(row); });
  return { tagged: tagged, untagged: untagged };
}

function _insCatTagDrill(ictx, title, rows, tag, from) {
  const drill = insDrill(ictx, title, rows, insTxQuery(from, ictx.period.to, { types: 'money-out', tag: tag }));
  const shared = rows.filter(function(row) { return _insCatRowTags(row).length > 1; }).length;
  drill.total_quote = _insCatTagShare(rows, tag);
  if (shared > 0) drill.subtitle += ' (' + shared + ' shared with other tags, split equally)';
  return drill;
}

function _insCatSplitNote(tagged) {
  return tagged.some(function(row) { return _insCatRowTags(row).length > 1; })
    ? [{ text: 'A transaction with several tags is split equally between them.' }] : [];
}

// ── 12-tag-pie ────────────────────────────────────────────────────────────────

// Donut of tagged spend by tag (top 7 + 'Other tags'), tag table (count,
// total, average), untagged spend as a stat card, per-tag transaction panel
// (drill { tag }). 'Other tags' is not drillable.
function insightCompute_12_tag_pie(ictx) {
  const spend = insFlows(ictx, { kind: 'spend' });
  const split = _insCatTagSplit(spend);
  const groups = _insCatTagGroups(split.tagged);
  const drillTag = insDrillValue(ictx, 'tag');
  let drillGroup = null;
  if (ictx.drill !== null) {
    drillGroup = drillTag === null ? undefined : groups.find(function(group) { return group.key === drillTag.toLowerCase(); });
    if (drillGroup === undefined) return insError('invalid_drill', 'drill');
  }
  if (groups.length === 0) return insEmpty('No tagged transactions in this period.');
  const from = _insCatFrom(ictx, spend);
  const segments = _insCatSegments(groups, 'Other tags', 'amount');
  const taggedTotal = insTotal(split.tagged);

  const payload = {
    stat_cards: [
      insStat('tags', 'Distinct tags', groups.length, 'count'),
      insStat('tagged', 'Tagged spend', taggedTotal, 'money', split.tagged.length + ' of ' + spend.length + ' expenses — tap a segment to drill'),
      insStat('untagged', 'Untagged spend', insTotal(split.untagged), 'money', split.untagged.length + ' expense' + (split.untagged.length === 1 ? '' : 's')),
    ],
    charts: [{
      id: 'tags', kind: 'donut', labels: segments.map(function(seg) { return seg.label; }),
      datasets: [{ key: 'spend', label: 'Tagged spend', data: segments.map(function(seg) { return seg.amount; }), style: 'palette' }],
      y_format: 'money', ref_lines: [],
      drill: { param: 'tag', values: segments.map(function(seg) { return seg.key === _INS_CAT_OTHER_KEY ? null : seg.key; }), mode: 'panel', hint: 'Tap a tag to see its transactions',
        null_text: 'Other tags groups the smaller tags — pick one from the table below to see its transactions.' },
    }],
    tables: [{
      id: 'tags', title: 'By tag',
      columns: [
        { key: 'tag', label: 'Tag', format: 'text', align: 'left' },
        { key: 'count', label: 'Txs', format: 'count', align: 'right' },
        { key: 'total', label: 'Total', format: 'money', align: 'right' },
        { key: 'avg', label: 'Avg', format: 'money', align: 'right' },
      ],
      rows: groups.map(function(group) {
        return { key: group.key, cells: { tag: group.label, count: group.count, total: group.amount, avg: group.count > 0 ? group.amount / group.count : 0 },
          drill: { param: 'tag', value: group.key, mode: 'panel' } };
      }),
      sortable: [], sort: null,
    }],
    notes: _insCatSplitNote(split.tagged),
    drill: null,
  };
  if (drillGroup !== null) payload.drill = _insCatTagDrill(ictx, 'Transactions tagged ' + drillGroup.label, drillGroup.rows, drillGroup.key, from);
  return payload;
}

// ── 13-tag-trend ──────────────────────────────────────────────────────────────

// Monthly split spend per tag (top 6 lines visible, the rest toggled from the
// legend). Drills (panel):
//   { month: 'YYYY-MM' }             tagged transactions that month + per-tag table
//   { tag: 't' }                     the tag's transactions + its monthly bars
//   { tag: 't', month: 'YYYY-MM' }   one tag in one month (a click on a line point:
//                                    drill.series_param sends the line's dataset key)
// A click elsewhere in a month column drills by month only; the tag table rows
// drill by tag.
function insightCompute_13_tag_trend(ictx) {
  const spend = insFlows(ictx, { kind: 'spend' });
  const split = _insCatTagSplit(spend);
  const groups = _insCatTagGroups(split.tagged);
  const from = _insCatFrom(ictx, spend);
  const months = from === null ? [] : ldgMonthKeys(from, ictx.period.to);
  const drillTagRaw = insDrillValue(ictx, 'tag');
  const drillTag = drillTagRaw === null ? null : drillTagRaw.toLowerCase();
  const drillMonth = insDrillValue(ictx, 'month');
  let drillGroup = null;
  if (ictx.drill !== null) {
    if (drillTag === null && drillMonth === null) return insError('invalid_drill', 'drill');
    if (drillMonth !== null && months.indexOf(drillMonth) === -1) return insError('invalid_drill', 'drill');
    if (drillTag !== null) {
      drillGroup = groups.find(function(group) { return group.key === drillTag; });
      if (drillGroup === undefined) return insError('invalid_drill', 'drill');
    }
  }
  if (groups.length === 0) return insEmpty('No tagged transactions in this period.');

  const shareByMonth = function(rows, tag) {
    const byMonth = Object.create(null);
    months.forEach(function(key) { byMonth[key] = 0; });
    rows.forEach(function(row) {
      if (byMonth[row.month_key] === undefined) return;
      const tags = _insCatRowTags(row);
      if (tags.indexOf(tag) !== -1) byMonth[row.month_key] += row.quote / tags.length;
    });
    return months.map(function(key) { return byMonth[key]; });
  };
  const labels = months.map(insMonthLabel);
  const datasets = groups.map(function(group, i) {
    return { key: group.key, label: group.label, data: shareByMonth(group.rows, group.key), style: 'palette:' + i, hidden: i >= _INS_CAT_VISIBLE_TAGS };
  });

  const payload = {
    stat_cards: [
      insStat('tags', 'Distinct tags', groups.length, 'count', groups.length > _INS_CAT_VISIBLE_TAGS ? 'top ' + _INS_CAT_VISIBLE_TAGS + ' shown' : null),
      insStat('top', 'Top tag', groups[0].amount, 'money', groups[0].label),
      insStat('untagged', 'Untagged spend', insTotal(split.untagged), 'money', split.untagged.length + ' of ' + spend.length + ' expenses'),
    ],
    charts: [{
      id: 'trend', kind: 'line', labels: labels, datasets: datasets, y_format: 'money', y_min: 0, ref_lines: [],
      drill: { param: 'month', series_param: 'tag', values: months, mode: 'panel', hint: 'Tap a point for that tag and month, or a month for all its tagged transactions' },
    }],
    tables: [{
      id: 'tags', title: 'By tag',
      columns: [
        { key: 'tag', label: 'Tag', format: 'text', align: 'left' },
        { key: 'count', label: 'Txs', format: 'count', align: 'right' },
        { key: 'total', label: 'Total', format: 'money', align: 'right' },
        { key: 'avg', label: 'Avg / month', format: 'money', align: 'right' },
      ],
      rows: groups.map(function(group) {
        return { key: group.key, cells: { tag: group.label, count: group.count, total: group.amount, avg: months.length > 0 ? group.amount / months.length : 0 },
          drill: { param: 'tag', value: group.key, mode: 'panel' } };
      }),
      sortable: [], sort: null,
    }],
    notes: _insCatSplitNote(split.tagged),
    drill: null,
  };

  if (drillGroup !== null) {
    const rows = drillMonth === null ? drillGroup.rows : drillGroup.rows.filter(function(row) { return row.month_key === drillMonth; });
    const title = drillMonth === null ? drillGroup.label : drillGroup.label + ' — ' + insMonthLabel(drillMonth);
    const drill = _insCatTagDrill(ictx, title, rows, drillGroup.key, from);
    if (drillMonth === null) {
      drill.charts = [{
        id: 'tag_months', kind: 'bar', title: drillGroup.label + ' by month', height: 180, labels: labels,
        datasets: [{ key: 'share', label: drillGroup.label, data: shareByMonth(drillGroup.rows, drillGroup.key), style: 'primary' }],
        y_format: 'money', y_min: 0, ref_lines: [],
      }];
    } else {
      const pointFrom = drillMonth + '-01' < from ? from : drillMonth + '-01';
      const pointTo = ldgMonthEnd(drillMonth + '-01') < ictx.period.to ? ldgMonthEnd(drillMonth + '-01') : ictx.period.to;
      drill.query = insTxQuery(pointFrom, pointTo, { types: 'money-out', tag: drillGroup.key });
    }
    payload.drill = drill;
  } else if (drillMonth !== null) {
    const rows = split.tagged.filter(function(row) { return row.month_key === drillMonth; });
    const monthGroups = _insCatTagGroups(rows);
    const monthFrom = drillMonth + '-01' < from ? from : drillMonth + '-01';
    const monthTo = ldgMonthEnd(drillMonth + '-01') < ictx.period.to ? ldgMonthEnd(drillMonth + '-01') : ictx.period.to;
    const drill = insDrill(ictx, insMonthLabel(drillMonth) + ' — tagged spend', rows, insTxQuery(monthFrom, monthTo, { types: 'money-out' }));
    drill.table = {
      id: 'month_tags', columns: [
        { key: 'tag', label: 'Tag', format: 'text', align: 'left' },
        { key: 'count', label: 'Txs', format: 'count', align: 'right' },
        { key: 'total', label: 'Share', format: 'money', align: 'right' },
      ],
      rows: monthGroups.map(function(group) {
        return { key: group.key, cells: { tag: group.label, count: group.count, total: group.amount } };
      }),
      sortable: [], sort: null, empty_text: 'No tagged spend this month',
    };
    payload.drill = drill;
  }
  return payload;
}
