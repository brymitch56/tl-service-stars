'use strict';
/**
 * grid.js — parser for the kartik-v GridView tables (Yii2) that Trail Life
 * Connect renders on /activities and on the trailman profile tabs.
 *
 * Header-driven: a caller looks a table up by the labels in its <th> row and
 * reads cells by label, so column order and cosmetic markup inside a cell can
 * change without breaking a read.
 *
 * Shapes handled (all observed live, 2026-09-19):
 *   - <thead> holds the label row AND a filter row (tr.filters) — skipped;
 *   - the page-summary row (tr.kv-page-summary, "Total Servant Service
 *     Records: N") can sit in its own <tbody class="kv-page-summary-container">
 *     or inside the data <tbody> — it is ALWAYS kept out of `rows` and
 *     exposed as `summaryRow`, because summing it double-counts every total;
 *   - the empty-grid placeholder ("No results found.") is one wide cell —
 *     dropped, so a trailman with no service records parses as zero rows
 *     rather than one phantom row;
 *   - the pager summary lives in div.summary of the enclosing div.grid-view.
 *
 * Nothing here follows a link. Cells expose their hrefs as data because some
 * of them are WRITES when fetched (/fields/toggleServiceActive flips a
 * service-hours approval; the per-row Menu carries edit/Delete controls).
 */
const { decodeHtml, attrsOf, textOf, hrefsOf } = require('./html');

const hasClass = (attrs, cls) => ` ${attrs.class || ''} `.includes(` ${cls} `);

/** Header label → canonical key: lower-case letters and digits only. */
const keyOf = (label) => String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

function parseRow(trAttrs, inner) {
  const cells = [];
  const re = /<(td|th)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  let m;
  while ((m = re.exec(inner))) {
    const a = attrsOf(m[2]);
    cells.push({
      tag: m[1].toLowerCase(),
      attrs: a,
      html: m[3],
      text: textOf(m[3]),
      hrefs: hrefsOf(m[3]),
      colspan: Number(a.colspan || 1),
    });
  }
  return { attrs: trAttrs, key: trAttrs['data-key'] || null, cells };
}

/**
 * Parse every <table> in an HTML string.
 * @returns {Array<{ id, pos, headers, keys, rows, summaryRow, summary, pagerHrefs }>}
 *   rows — data rows only: [{ key, cells, byKey: { <headerKey>: cell } }]
 *   summaryRow — the kv-page-summary cells, or null (never inside rows)
 *   summary — { from, to, total } / { total } from the pager text, or null
 */
function parseTables(html) {
  const out = [];
  const tableRe = /<table\b([^>]*)>([\s\S]*?)<\/table\s*>/gi;
  let m;
  while ((m = tableRe.exec(html || ''))) {
    const pos = m.index;
    const inner = m[2];
    const headers = [];
    const rows = [];
    let summaryRow = null;
    const trRe = /<tr\b([^>]*)>([\s\S]*?)<\/tr\s*>/gi;
    let t;
    while ((t = trRe.exec(inner))) {
      const a = attrsOf(t[1]);
      const row = parseRow(a, t[2]);
      if (!row.cells.length) continue;
      if (hasClass(a, 'kv-page-summary')) { summaryRow = row.cells; continue; }
      if (hasClass(a, 'filters')) continue;
      if (!headers.length && row.cells.every((c) => c.tag === 'th')) {
        for (const c of row.cells) headers.push(c.text);
        continue;
      }
      if (row.cells.every((c) => c.tag === 'th')) continue; // a second header row
      // kartik's empty-grid placeholder — one cell spanning the table.
      if (row.cells.length === 1
        && (row.cells[0].colspan > 1
          || /^no results found\.?$/i.test(row.cells[0].text)
          || /\bempty\b/.test(row.cells[0].attrs.class || ''))) continue;
      rows.push(row);
    }
    const keys = headers.map(keyOf);
    for (const r of rows) {
      r.byKey = {};
      let col = 0;
      for (const c of r.cells) {
        if (keys[col] !== undefined) r.byKey[keys[col]] = c;
        col += c.colspan;
      }
    }
    // enclosing grid-view container (nearest preceding) carries id + summary
    const before = (html || '').slice(0, pos);
    const gv = lastMatch(before, /<div\b([^>]*\bgrid-view\b[^>]*)>/gi);
    let id = null;
    let summary = null;
    if (gv) {
      id = attrsOf(gv.m[1]).id || null;
      const region = html.slice(gv.index, pos);
      const sm = /<div\b[^>]*\bclass=["'][^"']*\bsummary\b[^"']*["'][^>]*>([\s\S]*?)<\/div\s*>/i.exec(region);
      if (sm) summary = parseSummary(textOf(sm[1]));
    }
    // the grid's own pager, if one is rendered (the service ledger renders
    // none — see CLAUDE.md; page it by the ?page= parameter instead)
    const after = (html || '').slice(tableRe.lastIndex);
    const nextTable = after.search(/<table\b/i);
    const tail = nextTable >= 0 ? after.slice(0, nextTable) : after;
    const pg = /<ul\b[^>]*\bclass=["'][^"']*\bpagination\b[^"']*["'][^>]*>([\s\S]*?)<\/ul\s*>/i.exec(tail);
    out.push({ id, pos, headers, keys, rows, summaryRow, summary, pagerHrefs: pg ? [...new Set(hrefsOf(pg[1]))] : [] });
  }
  return out;
}

function lastMatch(s, re) {
  let last = null;
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(s))) last = { index: m.index, m };
  return last;
}

/** "Showing 1-25 of 40 items." → { from, to, total }; "Total 671 items." → { total }. */
function parseSummary(text) {
  let m;
  if ((m = /showing\s+([\d,]+)\s*[-–]\s*([\d,]+)\s+of\s+([\d,]+)\s+items?/i.exec(text))) {
    return { from: num(m[1]), to: num(m[2]), total: num(m[3]) };
  }
  if ((m = /total\s+([\d,]+)\s+items?/i.exec(text))) return { total: num(m[1]) };
  return null;
}
const num = (s) => Number(String(s).replace(/,/g, ''));

/** First table whose headers include EVERY label in `labels` (keyOf-compared). */
function findTable(tables, labels) {
  const want = labels.map(keyOf);
  return tables.find((t) => want.every((k) => t.keys.includes(k))) || null;
}

/** The table inside div#<id>-container / div#<id>, when the page names its grids. */
function tableById(tables, id) {
  return tables.find((t) => t.id === id || t.id === `${id}-container`) || null;
}

module.exports = { parseTables, findTable, tableById, parseSummary, keyOf, textOf, decodeHtml };
