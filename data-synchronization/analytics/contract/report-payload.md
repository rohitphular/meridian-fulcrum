# Report payload contract (version 1)

What the analytics job publishes for one report variant, and what the GAS reader returns to the app.
It keeps the shape of the earlier GAS insights (drawn by `expense-tracker/app/sections/reports/render-kinds.js`), with four changes:

1. **Every money value is XAU grams** (a JSON number, up to 9 decimals). GAS converts it to the
   display currency by multiplying with `rate[quote]` from the `rates` tab. Nothing else is computed in GAS.
2. **No money inside text.** Labels, titles, subtitles, notes and stat-card subs never contain an
   amount. Text that needs one uses placeholders `{0}`, `{1}` … and a `values` list (see "Text with values").
3. **All dates are UTC** (`YYYY-MM-DD`, `YYYY-MM`). `published_at` is a UTC ISO timestamp; the browser
   formats it in the local timezone.
4. **Drills** are either precomputed (`aggregate`) or a `query` that opens Transactions; a payload
   never carries transaction rows.

## Variant key

One payload per report and variant. The variant key is the variant's parameters, sorted by name,
as `name=value` joined with `&`, values percent-encoded; parameters at their default are left out.

| Parameter | When | Example |
|---|---|---|
| `period` | report has periods | `period=last_6` |
| `tab` | report has tabs | `tab=accounts` |
| `window`, `top_n` | report has that control | `window=30` |
| `drill` | an aggregate drill value, as `param:value` (`+` joins two params) | `drill=date%3A2026-08-31` |

The default variant has the empty key `""`. User-defined reports have one variant: `""`.

## Payload

```
{
  contract_version: 1,
  report_id,                 // report_master id
  predefined_key | null,     // null for user-defined reports
  variant_key,
  anchor_date,               // UTC date the periods were computed from (the run date)
  title, description,
  period: { key, label, from, to, days, compare_from, compare_to } | null,
  compare: { mode, from, to, label } | null,
  tab: key | null, tabs: [{ key, label, active }],
  controls: [{ param, label?, value, options: [{ value, label }] }],
  stat_cards: [{ key, label, value, format, sub?: Text, tone? }],
  charts: [Chart],
  tables: [Table],
  drill: Drill | null,
  breadcrumbs: [{ label, drill: { param: value } | null }],
  notes: [Text & { tone? }],
  empty: { text } | null,
  warnings: [{ code: 'missing_rate', currencies: [code] } | { code, ... }]
}
```

`Chart`, `Table`, the `FORMAT`, `TONE` and `STYLE` enums, `gauge`, `ref_lines` and `drill` on a chart
are as follows, with the rules after them:

```
Chart = { id, kind: 'line'|'bar'|'hbar'|'stacked'|'stacked_hbar'|'area'|'mixed'|'donut'|'pie'|'gauge'|'waterfall',
          title?, height? (px hint), labels: [string],
          datasets: [{ key, label, data: [number|null] (waterfall: [[start, end]]), style: STYLE,
                       kind?: 'bar'|'line' (mixed only), dashed?, fill?: 'none'|'origin'|'signed',
                       point_tones?: [TONE per point], axis?: 'y'|'y2', hidden? }],
          y_format: FORMAT, y2_format?, y_min?, y_max?, ref_lines: [{ value, label, tone?, axis? }],
          gauge?: { value, max, status, label, sub?, tone? }, drill? (below), empty_text? }
Table = { id, title?, columns: [{ key, label, format: FORMAT, align: 'left'|'right'|'center' }],
          rows: [{ key, cells: { col: value | Text }, tone?, drill? }], total_row?: { cells },
          sortable: [col], sort: { col, dir } | null, empty_text? }
FORMAT = 'money' | 'money2' | 'money_delta' | 'percent' | 'percent_delta' | 'count' | 'days' | 'text'
       | 'date' (YYYY-MM-DD) | 'month' (YYYY-MM) | 'progress' (0–100, table cells) | 'local' (below)
TONE   = 'positive'|'negative'|'neutral'|'warn'|'muted'|'primary'|'highlight'
STYLE  = 'primary'|'compare'|'income'|'expense'|'savings'|'asset'|'liability'|'muted'|'palette'|'palette:<n>'
```

The app maps tone and style to colours and formats values; it holds no data logic. Rules:

- `waterfall` datasets hold `[start, end]` pairs; both are money.
- `ref_lines[].value` uses the axis format (`y_format` or `y2_format` when `axis: 'y2'`).
- `gauge.value` / `gauge.max` are percentages; never money.
- A chart drill or table-row drill with `published: aggregate` names a variant that exists; with
  `query_only` it carries `query: { action: 'list_transactions_view', params }` instead.

Chart drill modes (`charts[].drill`):

| `mode` | Shape | Meaning |
|---|---|---|
| `panel` | `{ param, values: [v \| null], mode, hint?, series_param? }` | the variant `drill=<param>:<value>` holds `drill` (a Drill panel) |
| `replace` | `{ param, values, mode, hint? }` | the variant `drill=<param>:<value>` replaces the report body; `breadcrumbs` lead back |
| `query` | `{ param, values, mode, queries: [Query \| null], hint?, null_text? }` | no variant: `queries[i]` opens Transactions for `values[i]`; `null` = not drillable |

Table-row drills: `{ param, value, mode: 'panel' }` (a variant exists) or
`{ param, value, mode: 'query', query: Query }`. `Query = { action: 'list_transactions_view', params, note }`.

Number reports (`kind: number`, the Home tiles) carry one stat card with `key: 'value'` and no
charts or tables.

Formats: `local` is an amount in the account's own currency (the row says which, e.g. a
`currency` cell); it is never converted. `progress` is a 0–100 percentage.

### Text with values

```
Text = { text: 'Down {0} on last month', values: [{ value: 412.5, format: 'money_delta' }] }
```

GAS converts money `values`; the browser formats them and fills the placeholders. A plain string
is allowed where no amount is needed.

### Drill

```
Drill = { title, subtitle?: Text, charts?: [Chart], table?: Table, query?: { action, params, note } }
```

## Which values GAS converts

A value is money when its format is `money`, `money2` or `money_delta`:

| Place | Format comes from |
|---|---|
| `stat_cards[].value` | the card's `format` |
| `charts[].datasets[].data` (and waterfall pairs) | the chart's `y_format`, or `y2_format` for `axis: 'y2'` datasets (default `money`) |
| `charts[].ref_lines[].value` | as above, by `axis` |
| `tables[].rows[].cells.<col>`, `total_row.cells.<col>` | the column's `format` |
| `values[]` in any Text (stat `sub`, `notes`, table cells, drill `title` / `subtitle`) | each value's `format` |
| the same places inside `drill` (`drill.charts`, `drill.table`) | as above |

Everything else (counts, percentages, days, dates, text, `local`) is returned unchanged. A missing rate for
the display currency means money values are returned as `null` with a `missing_rate` warning —
never converted 1:1.

## Envelope returned by GAS

```
{ ok: true, published_at, generation_id, quote: { currency, symbol, rate, rate_date }, warnings, data: <payload> }
```

`warnings` = the payload's warnings plus reader warnings (`not_published`, `report_failed`, `missing_rate`).

## Sizes

A payload is split into chunks of at most 45,000 characters (a Sheets cell holds 50,000). The
reader joins the chunks of one variant in `chunk_no` order and parses the JSON.
