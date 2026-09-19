'use strict';
/**
 * html.js — the small HTML helpers every other parser here is built on.
 *
 * This project reads Yii2/kartik GridView pages with regexes rather than a
 * DOM dependency (same policy as troop-checkin's roster fetch, which has
 * parsed this exact platform in production since 2026). The scanners are
 * deliberately forgiving about attribute order and quoting, because the
 * portal's markup changes cosmetically without warning.
 */

/** Decode the entity set the portal actually emits. */
const decodeHtml = (s) => String(s ?? '')
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#0?34;/g, '"')
  .replace(/&nbsp;/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * One attribute out of a raw tag-attribute string, decoded; null when absent.
 * Built on attrsOf rather than a per-name regex so there is one scanner to
 * get right, and so an attribute whose name appears inside another's value
 * cannot be picked up by accident.
 */
function attrOf(tagAttrs, name) {
  const v = attrsOf(tagAttrs)[String(name).toLowerCase()];
  return v === undefined ? null : v;
}

const ATTR_RE = /([\w:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
/** Every attribute of a raw tag-attribute string, lower-cased keys. */
function attrsOf(s) {
  const out = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(s || ''))) {
    if (m[1] === '/') continue;
    out[m[1].toLowerCase()] = decodeHtml(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

/** Visible text of a snippet: scripts dropped, tags stripped, space collapsed. */
function textOf(html) {
  return decodeHtml(String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every <a href> in a snippet, decoded. Data only — these are never fetched. */
function hrefsOf(html) {
  const out = [];
  const re = /<a\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html || ''))) {
    const h = attrOf(m[1], 'href');
    if (h) out.push(h);
  }
  return out;
}

/** <form> elements as { attrs, body }. */
function formsIn(html) {
  const out = [];
  const re = /<form\b([^>]*)>([\s\S]*?)<\/form\s*>/gi;
  let m;
  while ((m = re.exec(html || ''))) out.push({ attrs: m[1], body: m[2] });
  return out;
}

/**
 * Named <input> elements of a form body as { name, type, value, checked }.
 * `checked` matters because a browser does not submit an unchecked box, and
 * neither should we when echoing a form back.
 */
function inputsIn(body) {
  const out = [];
  const re = /<input\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(body || ''))) {
    // Parse the attributes once. Scanning the raw string for /\bchecked\b/
    // is wrong on this platform: the advancement form has inputs NAMED
    // "lock-checked" and "show-items-checked", so a text search reports every
    // one of them as checked and the echo would silently set them.
    const a = attrsOf(m[1]);
    if (!a.name) continue;
    out.push({
      name: a.name,
      type: (a.type || 'text').toLowerCase(),
      value: a.value || '',
      checked: Object.prototype.hasOwnProperty.call(a, 'checked'),
    });
  }
  return out;
}

/** Named <textarea> elements of a form body as { name, value }. */
function textareasIn(body) {
  const out = [];
  const re = /<textarea\b([^>]*)>([\s\S]*?)<\/textarea\s*>/gi;
  let m;
  while ((m = re.exec(body || ''))) {
    const name = attrOf(m[1], 'name');
    if (!name) continue;
    out.push({ name, value: decodeHtml(m[2] || '') });
  }
  return out;
}

/**
 * Yii2 renders the CSRF token both as a <meta> and as a hidden input, and
 * the attribute order varies. Prefer the meta tag.
 */
function csrfFrom(html) {
  const page = String(html || '');
  const meta = page.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i)
            || page.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']csrf-token["']/i);
  if (meta) return decodeHtml(meta[1]);
  const hidden = page.match(/name=["']_csrf[^"']*["'][^>]*value=["']([^"']+)["']/i)
              || page.match(/value=["']([^"']+)["'][^>]*name=["']_csrf[^"']*["']/i);
  return hidden ? decodeHtml(hidden[1]) : null;
}

/**
 * "12/08/2025" / "12/8/25" / "2025-12-08" → "2025-12-08"; anything else, and
 * the portal's epoch-0 artefact, → null.
 */
function parseTlcDate(s) {
  if (s === null || s === undefined) return null;
  const t = String(s).trim();
  if (!t) return null;
  let y; let mo; let d; let m;
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(t))) {
    mo = Number(m[1]); d = Number(m[2]); y = Number(m[3]);
    if (m[3].length === 2) y += y >= 69 ? 1900 : 2000;
  } else if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t))) {
    y = Number(m[1]); mo = Number(m[2]); d = Number(m[3]);
  } else {
    return null;
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if ((y === 1969 && mo === 12 && d === 31) || (y === 1970 && mo === 1 && d === 1)) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** "2025-12-08" → "12/08/2025" — the format the portal's date fields take. */
function toPortalDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  return m ? `${m[2]}/${m[3]}/${m[1]}` : null;
}

module.exports = {
  decodeHtml, attrOf, attrsOf, textOf, hrefsOf,
  formsIn, inputsIn, textareasIn, csrfFrom, parseTlcDate, toPortalDate,
};
