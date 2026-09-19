'use strict';
/* Service Stars — the whole client. No framework: this is four screens of
   tables over a small JSON API, and a build step would cost more than it
   saves on a Pi that a volunteer has to redeploy.

   Rendering rule: every value that came from the server goes through el()/
   text nodes, never innerHTML, so a trailman named O'Brien or a portal
   warning containing a < cannot break (or inject into) the page. */

const XRW = 'tl-service-stars';
const state = { user: null, troop: null, settings: {}, tab: 'trailmen', progress: null, detailId: null };

// ------------------------------------------------------------------ api ---
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'X-Requested-With': XRW } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ------------------------------------------------------------------ dom ---
/** el('div.card', {onclick}, 'text', childNode, …) */
function el(spec, attrs, ...kids) {
  const [tag, ...classes] = String(spec).split('.');
  const n = document.createElement(tag || 'div');
  if (classes.length) n.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'style') n.setAttribute('style', v);
    else if (k in n && k !== 'list') n[k] = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return n;
}
const $ = (sel) => document.querySelector(sel);
const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); return n; };

let toastTimer = null;
function toast(msg, bad = false) {
  const existing = $('.toast');
  if (existing) existing.remove();
  const t = el('div.toast', { className: `toast${bad ? ' bad' : ''}` }, msg);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), bad ? 7000 : 3500);
}

/** "★★★☆" — filled for what is on record, hollow for what is proposed. */
function starRow(onRecord, proposed) {
  const n = el('span.stars');
  for (let i = 0; i < onRecord; i++) n.append('★');
  for (let i = 0; i < proposed; i++) n.append(el('span', { style: 'opacity:.55' }, '★'));
  if (!onRecord && !proposed) n.append(el('span.empty', {}, '—'));
  return n;
}

function meter(pct) {
  return el('div.meter', { title: `${pct}% of the way to the next star` },
    el('span', { style: `width:${Math.max(0, Math.min(100, pct))}%` }));
}

const fmtDate = (iso) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

// --------------------------------------------------------------- sign in ---
function showLogin(message) {
  $('#app').hidden = true;
  $('#login-screen').hidden = false;
  if (message) $('#login-error').textContent = message;
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    const { user } = await api('/api/signin', {
      method: 'POST',
      body: { email: $('#email').value, password: $('#password').value },
    });
    if (user.mustChange) {
      $('#login-fields').hidden = true;
      $('#change-fields').hidden = false;
      $('#new-password').focus();
      return;
    }
    await start();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#change-submit').addEventListener('click', async () => {
  $('#login-error').textContent = '';
  const a = $('#new-password').value;
  const b = $('#new-password2').value;
  if (a !== b) { $('#login-error').textContent = 'Those two do not match.'; return; }
  try {
    await api('/api/password', {
      method: 'POST',
      body: { currentPassword: $('#password').value, newPassword: a },
    });
    await start();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#signout').addEventListener('click', async () => {
  await api('/api/signout', { method: 'POST' }).catch(() => {});
  location.reload();
});

$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) go(b.dataset.tab);
});

function go(tab) {
  state.tab = tab;
  state.detailId = null;
  for (const b of document.querySelectorAll('#tabs button')) {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  render();
}

// ----------------------------------------------------------------- views ---
async function render() {
  const view = clear($('#view'));
  view.append(el('p.spin', {}, 'Loading…'));
  try {
    const node = state.detailId ? await viewTrailman(state.detailId)
      : state.tab === 'review' ? await viewReview()
        : state.tab === 'runs' ? await viewRuns()
          : state.tab === 'settings' ? await viewSettings()
            : await viewTrailmen();
    clear(view).append(node);
  } catch (err) {
    if (err.status === 401) { showLogin('Your session expired — sign in again.'); return; }
    clear(view).append(el('div.card.warn', {}, el('h2', {}, 'Could not load this page'), el('p.error', {}, err.message)));
  }
}

/** Roster overview. */
async function viewTrailmen() {
  const data = await api('/api/progress');
  state.progress = data;
  const frag = document.createDocumentFragment();

  const syncBtn = el('button.btn', {
    onclick: async () => {
      syncBtn.disabled = true;
      syncBtn.textContent = 'Reading Trail Life Connect…';
      try {
        const r = await api('/api/sync', { method: 'POST' });
        toast(r.error || `Synced ${r.summary.read} trailmen — ${r.summary.proposed} new star(s) proposed`, !r.ok);
      } catch (e) {
        toast(e.message, true);
      }
      await refreshCounts();
      render();
    },
  }, 'Sync now');

  frag.append(el('div.page-head', {},
    el('h2', {}, 'Trailmen'),
    el('span.muted.small', {}, `${data.trailmen.length} on the roster`),
    el('span.spacer'),
    syncBtn));

  if (!data.trailmen.length) {
    frag.append(el('div.card', {},
      el('h3', {}, 'Nothing here yet'),
      el('p.muted', {}, 'Press “Sync now” to read the troop’s service hours from Trail Life Connect. '
        + 'If the portal asks for a sign-in code, an admin finishes that under Settings.')));
    return frag;
  }

  const body = el('tbody');
  for (const t of data.trailmen) {
    const nav = t.levels.find((l) => l.level === 'Navigator') || {};
    const adv = t.levels.find((l) => l.level === 'Adventurer') || {};
    const cell = (l) => el('td', {},
      starRow(l.onRecord || 0, Math.max(0, (l.expected || 0) - (l.onRecord || 0))),
      el('div.small.muted.num', {}, `${l.hours || '0.00'} h`),
      l.conflict ? el('span.pill.conflict', {}, 'check') : null);
    body.append(el('tr.rowlink', { onclick: () => { state.detailId = t.id; render(); } },
      el('td', {}, el('strong', {}, t.name),
        t.newStars ? el('span.pill.new', { style: 'margin-left:8px' }, `${t.newStars} owed`) : null),
      cell(nav),
      cell(adv),
      el('td', {},
        meter(Math.max(nav.pct || 0, adv.pct || 0)),
        el('div.small.muted', {}, nextLine(nav, adv))),
      el('td.r.small.muted.num', {}, t.woodlands !== '0.00' ? `${t.woodlands} h` : '—')));
  }

  frag.append(el('div.card', { style: 'padding:0;overflow:hidden' },
    el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'Trailman'),
        el('th', {}, 'Navigator · 15 h'),
        el('th', {}, 'Adventurer · 20 h'),
        el('th', {}, 'Toward next'),
        el('th.r', { title: 'Fox, Hawk and Mountain Lion hours — never counted' }, 'Woodlands'))),
      body)));
  frag.append(el('p.small.muted', {},
    'Filled stars are on the Trail Life Connect record; pale stars are owed and waiting in Review. '
    + 'Woodlands hours are shown for reference only — they never count toward a star and never carry forward.'));
  return frag;
}

function nextLine(nav, adv) {
  const live = (adv.onRecord || adv.expected || (nav.expected && !nav.toNext)) ? adv : nav;
  const l = live.level ? live : nav;
  return l.toNext ? `${l.toNext} h to the next ${l.level} star` : '';
}

/** One trailman: the arithmetic, spelled out, plus his ledger. */
async function viewTrailman(id) {
  const d = await api(`/api/trailmen/${id}`);
  const frag = document.createDocumentFragment();
  frag.append(el('div.page-head', {},
    el('button.btn.ghost.small', { onclick: () => { state.detailId = null; render(); } }, '← All trailmen'),
    el('h2', {}, d.trailman.name),
    el('span.spacer')));

  const cards = el('div.grid2');
  for (const l of d.chain.levels) {
    const proposed = d.proposals.filter((p) => p.level === l.level);
    const card = el('div.levelcard', {},
      el('h3', {}, l.level, el('span.pill.level', {}, `${(l.rate / 100).toFixed(0)} h per star`)),
      starRow(l.onRecord, Math.max(0, l.expected - l.onRecord)),
      el('dl.kv', {},
        el('dt', {}, 'Counted hours'), el('dd', {}, `${l.display.hours} h`),
        l.carryIn ? el('dt', {}, 'Carried in') : null,
        l.carryIn ? el('dd', {}, `${l.display.carryIn} h from Navigator`) : null,
        l.credit ? el('dt', {}, 'Woodlands credit') : null,
        l.credit ? el('dd', {}, `${l.display.credit} h`) : null,
        el('dt', {}, 'Available'), el('dd', {}, `${l.display.available} h`),
        el('dt', {}, 'Stars earned'), el('dd', {}, String(l.earnable)),
        l.legacy ? el('dt', {}, 'Standing (not from hours)') : null,
        l.legacy ? el('dd', {}, String(l.legacy)) : null,
        el('dt', {}, 'On the portal'), el('dd', {}, String(l.onRecord)),
        el('dt', {}, 'Toward next'), el('dd', {}, `${l.display.carryOut} of ${(l.rate / 100).toFixed(0)} h`)),
      meter(l.toNext.pct));

    if (l.conflict) {
      card.append(el('div.note.warn', {},
        l.conflict.kind === 'instance_removed'
          ? `A star instance has disappeared from the portal: ${l.conflict.onRecord} there now, ${l.conflict.baselineOnRecord} when this app first looked.`
          : `${l.conflict.onRecord} stars are on the portal but the counted hours explain ${l.conflict.expected}. `
            + 'Choose below how that extra should be treated.'));
    }
    if (l.unexplainedExtras > 0 || l.legacyMode !== 'separate') {
      card.append(legacyChooser(d.trailman.id, l));
    }
    if (proposed.length) {
      card.append(el('div.note', {}, `${proposed.length} star(s) waiting in Review.`));
    }
    cards.append(card);
  }
  frag.append(cards);

  // The ledger, newest first, with what counts and what does not.
  const rows = [...d.serviceRows].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const body = el('tbody');
  for (const r of rows) {
    body.append(el('tr', { style: r.counts ? '' : 'opacity:.55' },
      el('td.num', {}, fmtDate(r.date)),
      el('td', {}, r.description || '—'),
      el('td.r.num', {}, `${r.hours} h`),
      el('td', {}, el('span.pill.level', {}, r.level || 'no level')),
      el('td', {}, r.verified === true ? el('span.pill.ok', {}, 'verified')
        : el('span.pill.conflict', {}, r.verified === false ? 'not verified' : 'unknown')),
      el('td.small.muted', {}, r.counts ? 'counts' : reasonNotCounted(r))));
  }
  frag.append(el('div.card', { style: 'padding:0;overflow:hidden' },
    el('div', { style: 'padding:14px 16px 0' },
      el('h3', {}, 'Service record'),
      el('p.small.muted', {}, `${rows.length} record(s), mirrored from Trail Life Connect.`)),
    el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'Date'), el('th', {}, 'Act of service'), el('th.r', {}, 'Hours'),
        el('th', {}, 'Level'), el('th', {}, 'Verified'), el('th', {}, ''))),
      body)));
  return frag;
}

function reasonNotCounted(r) {
  if (r.verified !== true) return 'unverified hours never count';
  if (!r.level) return 'no level on the record';
  if (['Fox', 'Hawk', 'Mountain Lion'].includes(r.level)) return 'Woodlands — never counts';
  return 'not counted';
}

/** The leader's ruling about stars the hours do not explain. */
function legacyChooser(trailmanId, l) {
  const sel = el('select', {},
    el('option', { value: 'separate', selected: l.legacyMode === 'separate' }, 'Stand on their own (paper-era star)'),
    el('option', { value: 'woodlands', selected: l.legacyMode === 'woodlands' }, 'Were earned on Woodlands hours'),
    el('option', { value: 'fresh', selected: l.legacyMode === 'fresh' }, 'Stand — and restart this level from a date'));
  const wrap = el('div', { style: 'margin-top:10px' },
    el('label', { for: `lm-${l.level}` }, `Extra ${l.level} stars on the portal`),
    sel,
    el('p.small.muted', {}, legacyExplain(l.legacyMode, l)),
    el('button.btn.small.ghost', {
      onclick: async () => {
        try {
          await api(`/api/trailmen/${trailmanId}/legacy-mode`, {
            method: 'POST', body: { level: l.level, mode: sel.value },
          });
          toast('Saved — the arithmetic has been redone.');
          render();
        } catch (e) { toast(e.message, true); }
      },
    }, 'Save'));
  sel.id = `lm-${l.level}`;
  sel.addEventListener('change', () => { wrap.querySelector('p').textContent = legacyExplain(sel.value, l); });
  return wrap;
}

function legacyExplain(mode, l) {
  if (mode === 'woodlands') {
    return 'The troop awarded these before Woodlands hours were excluded. They stand, and a fixed credit '
      + 'covers exactly the hours they needed — so every hour since then counts toward the next star.';
  }
  if (mode === 'fresh') {
    return `Every ${l.level} star on the portal stands, and the level starts over: only hours from the start `
      + 'of the current program year count, with nothing carried in.';
  }
  return 'These are treated as stars the ledger never held. They stack on top of what the hours earn, so the '
    + 'next star still needs a full allotment of new hours.';
}

/** Stars waiting for a decision. */
async function viewReview() {
  const [{ proposals }, pushInfo] = await Promise.all([
    api('/api/proposals?status=proposed'),
    state.user.role === 'admin' ? api('/api/push').catch(() => null) : Promise.resolve(null),
  ]);
  const frag = document.createDocumentFragment();
  frag.append(el('div.page-head', {}, el('h2', {}, 'Review'), el('span.muted.small', {},
    `${proposals.length} star(s) the hours say are owed`)));

  if (pushInfo && !pushInfo.enabled) {
    frag.append(el('div.card', {},
      el('p', {}, el('strong', {}, 'Recording to Trail Life Connect is off.'),
        ' Approving a star queues it here; nothing is written to the portal until an admin turns the switch on '
        + 'under Settings. Until then, enter approved stars on the portal by hand.')));
  }

  if (!proposals.length) {
    frag.append(el('div.card', {}, el('h3', {}, 'Nothing waiting'),
      el('p.muted', {}, 'Every star the counted hours support is already on the portal or already decided.')));
    return frag;
  }

  const body = el('tbody');
  for (const p of proposals) {
    const act = (kind) => async () => {
      try {
        const r = await api(`/api/proposals/${p.id}/${kind}`, { method: 'POST' });
        toast(kind === 'approve'
          ? (r.pushEnabled ? 'Approved and queued for the portal.' : 'Approved — queued, waiting for the portal switch.')
          : 'Rejected. It will not be proposed again unless you reopen it.');
        await refreshCounts();
        render();
      } catch (e) { toast(e.message, true); }
    };
    body.append(el('tr', {},
      el('td', {}, el('a', {
        href: '#', onclick: (e) => { e.preventDefault(); state.detailId = p.trailman_id; render(); },
      }, p.trailman_name)),
      el('td', {}, el('span.pill.level', {}, p.level), ` star #${p.ordinal}`),
      el('td.num', {}, fmtDate(p.completed_on)),
      el('td.small.muted', {}, `at ${(p.hundredths_at_proposal / 100).toFixed(2)} h available`),
      el('td.r', {},
        el('button.btn.small', { onclick: act('approve') }, 'Approve'),
        ' ',
        el('button.btn.small.ghost', { onclick: act('reject') }, 'Reject'))));
  }
  frag.append(el('div.card', { style: 'padding:0;overflow:hidden' },
    el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'Trailman'), el('th', {}, 'Star'), el('th', {}, 'Earned on'),
        el('th', {}, ''), el('th.r', {}, ''))),
      body)));
  frag.append(el('p.small.muted', {}, '“Earned on” is the date his hours crossed the threshold, '
    + 'taken from the service record — not the date this app noticed.'));
  return frag;
}

/** Sync history and what each run warned about. */
async function viewRuns() {
  const { runs } = await api('/api/runs');
  const frag = document.createDocumentFragment();
  frag.append(el('div.page-head', {}, el('h2', {}, 'Sync log')));
  if (!runs.length) { frag.append(el('div.card', {}, el('p.muted', {}, 'No runs yet.'))); return frag; }
  for (const r of runs) {
    const s = r.summary || {};
    const card = el('div.card', { className: `card${r.ok ? '' : ' warn'}` },
      el('h3', {}, `${r.kind === 'push' ? 'Portal write' : 'Sync'} · ${fmtWhen(r.started_at)}`,
        ' ', el('span.pill', { className: `pill ${r.ok ? 'ok' : 'conflict'}` }, r.ok ? 'ok' : 'failed')),
      el('p.small.muted', {}, `${r.trigger || 'manual'}${r.actor ? ` · ${r.actor}` : ''}`),
      el('p', {}, r.kind === 'push'
        ? `${s.attempted || 0} attempted · ${s.confirmed || 0} confirmed · ${s.held || 0} held · ${s.failed || 0} failed`
        : `${s.read || 0} of ${s.trailmen || 0} trailmen read · ${s.proposed || 0} proposed · `
          + `${s.recorded || 0} already recorded · ${s.conflicts || 0} conflict(s)`
          + (s.incomplete ? ` · ${s.incomplete} skipped for an incomplete ledger` : '')));
    if (s.error) card.append(el('p.error', {}, s.error));
    if (r.warnings && r.warnings.length) {
      const list = el('ul.small.muted', { style: 'margin:8px 0 0;padding-left:18px' });
      for (const w of r.warnings.slice(0, 12)) list.append(el('li', {}, w));
      if (r.warnings.length > 12) list.append(el('li', {}, `…and ${r.warnings.length - 12} more`));
      card.append(el('details', {}, el('summary.small', { style: 'cursor:pointer' },
        `${r.warnings.length} warning(s)`), list));
    }
    frag.append(card);
  }
  return frag;
}

/** Admin: the portal connection, the push switch, and who may sign in. */
async function viewSettings() {
  const [portal, pushInfo, { users }] = await Promise.all([
    api('/api/portal'), api('/api/push'), api('/api/users'),
  ]);
  const frag = document.createDocumentFragment();
  frag.append(el('div.page-head', {}, el('h2', {}, 'Settings')));

  // --- Trail Life Connect ---------------------------------------------
  const pc = el('div.card', {}, el('h3', {}, 'Trail Life Connect'));
  pc.append(el('p.small.muted', {}, portal.base));
  pc.append(el('p', {},
    portal.session.connected
      ? el('span.pill.ok', {}, 'connected')
      : el('span.pill.conflict', {}, 'not connected'),
    portal.session.last_ok_at ? el('span.small.muted', {}, `  last used ${fmtWhen(portal.session.last_ok_at)}`) : null));

  if (!portal.credentials.saved) {
    pc.append(el('p.small.muted', {}, 'Save the leader account this app should read the portal with. '
      + 'It is encrypted with a key kept outside the database.'));
  } else {
    pc.append(el('p.small.muted', {}, `Signing in as ${portal.credentials.email}.`));
  }
  const em = el('input', { type: 'email', autocomplete: 'off', value: portal.credentials.email || '' });
  const pw = el('input', { type: 'password', autocomplete: 'new-password' });
  pc.append(el('label', {}, 'Portal e-mail'), em, el('label', {}, 'Portal password'), pw);
  pc.append(el('div.actions', {},
    el('button.btn.ghost', {
      onclick: async () => {
        try {
          await api('/api/portal/credentials', { method: 'POST', body: { email: em.value, password: pw.value } });
          toast('Saved.'); render();
        } catch (e) { toast(e.message, true); }
      },
    }, 'Save credentials'),
    el('button.btn', {
      onclick: async (ev) => {
        ev.target.disabled = true;
        ev.target.textContent = 'Signing in…';
        try {
          const r = await api('/api/portal/connect', { method: 'POST' });
          if (r.codeRequired) { toast('The portal sent a code — enter it below.'); }
          else toast('Connected.');
        } catch (e) { toast(e.message, true); }
        render();
      },
    }, portal.session.connected ? 'Reconnect' : 'Connect'),
    portal.session.connected ? el('button.btn.ghost', {
      onclick: async () => { await api('/api/portal/disconnect', { method: 'POST' }); toast('Disconnected.'); render(); },
    }, 'Disconnect') : null));

  if (portal.challenge) {
    const code = el('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code' });
    pc.append(el('div.note.warn', {},
      el('p', {}, el('strong', {}, 'The portal wants a sign-in code.'),
        portal.challenge.prompt ? ` ${portal.challenge.prompt}` : ''),
      el('p.small', {}, 'Type the code from your phone. This is the only step that needs a person — '
        + 'once it is done, the nightly sync runs on its own until the portal expires the session.'),
      code,
      el('div.actions', {}, el('button.btn', {
        onclick: async () => {
          try {
            await api('/api/portal/code', { method: 'POST', body: { id: portal.challenge.id, code: code.value } });
            toast('Connected.'); render();
          } catch (e) { toast(e.message, true); }
        },
      }, 'Finish signing in'))));
  }
  frag.append(pc);

  // --- the push --------------------------------------------------------
  const queue = pushInfo.queue || [];
  const waiting = queue.filter((q) => q.state === 'queued');
  const held = queue.filter((q) => q.state === 'held' || q.state === 'failed');
  const puc = el('div.card', { className: pushInfo.enabled ? 'card' : 'card warn' },
    el('h3', {}, 'Recording stars on Trail Life Connect'),
    el('p', {}, 'When this is on, approved stars are written to the portal as new award instances. '
      + 'Every save is proved by reading the record back; anything unconfirmed is held for a person and '
      + 'never retried automatically.'),
    el('label.inline', {},
      el('input', {
        type: 'checkbox',
        checked: !!pushInfo.enabled,
        onchange: async (ev) => {
          try {
            await api('/api/push/enabled', { method: 'POST', body: { enabled: ev.target.checked } });
            toast(ev.target.checked ? 'Writing to the portal is ON.' : 'Writing to the portal is off.');
            render();
          } catch (e) { toast(e.message, true); render(); }
        },
      }),
      'Write approved stars to Trail Life Connect'),
    el('p.small.muted', {}, `${waiting.length} waiting · ${held.length} held · `
      + `${queue.filter((q) => q.state === 'confirmed').length} confirmed`),
    el('div.actions', {}, el('button.btn', {
      disabled: !pushInfo.enabled || !waiting.length,
      onclick: async (ev) => {
        ev.target.disabled = true;
        ev.target.textContent = 'Writing…';
        try {
          const r = await api('/api/push/run', { method: 'POST' });
          toast(r.error || `${r.summary.confirmed} confirmed, ${r.summary.held} held, ${r.summary.failed} failed`, !r.ok);
        } catch (e) { toast(e.message, true); }
        render();
      },
    }, 'Push now')));

  if (queue.length) {
    const body = el('tbody');
    for (const q of queue.slice(0, 40)) {
      body.append(el('tr', {},
        el('td', {}, q.trailman_name),
        el('td', {}, el('span.pill.level', {}, q.level), q.ordinal ? ` #${q.ordinal}` : ''),
        el('td.num', {}, fmtDate(q.completed_on)),
        el('td', {}, el('span.pill', {
          className: `pill ${q.state === 'confirmed' ? 'ok' : (q.state === 'queued' ? '' : 'conflict')}`,
        }, q.state)),
        el('td.small.muted', {}, q.detail || ''),
        el('td.r', {}, ['held', 'failed'].includes(q.state)
          ? el('button.btn.small.ghost', {
            onclick: async () => {
              try { await api(`/api/push/${q.id}/requeue`, { method: 'POST' }); toast('Back in the queue.'); render(); } catch (e) { toast(e.message, true); }
            },
          }, 'Requeue')
          : (q.state === 'queued' ? el('button.btn.small.ghost', {
            onclick: async () => {
              try { await api(`/api/push/${q.id}/cancel`, { method: 'POST' }); toast('Cancelled.'); render(); } catch (e) { toast(e.message, true); }
            },
          }, 'Cancel') : null))));
    }
    puc.append(el('div', { style: 'margin-top:12px;overflow:auto' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Trailman'), el('th', {}, 'Star'), el('th', {}, 'Earned on'),
        el('th', {}, 'State'), el('th', {}, 'Detail'), el('th.r', {}, ''))), body)));
  }
  frag.append(puc);

  // --- leaders ---------------------------------------------------------
  const uc = el('div.card', {}, el('h3', {}, 'Who may sign in'));
  const ubody = el('tbody');
  for (const u of users) {
    const act = async (path, label) => {
      try {
        const r = await api(`/api/users/${u.id}/${path}`, { method: 'POST' });
        // Refresh the list FIRST — render() clears #view, and the dialog must
        // outlive that. It lives on <body>, but the order still matters so
        // the page behind it is up to date while it is open.
        await render();
        if (r.tempPassword) showTempPassword(u.email, r.tempPassword);
        else toast(label);
      } catch (e) { toast(e.message, true); }
    };
    ubody.append(el('tr', { style: u.disabled ? 'opacity:.55' : '' },
      el('td', {}, el('strong', {}, u.name), el('div.small.muted', {}, u.email)),
      el('td', {}, el('span.pill', { className: `pill ${u.role === 'admin' ? 'level' : ''}` }, u.role),
        u.envAdmin ? el('div.small.muted', {}, 'from .env') : null),
      el('td.small.muted', {}, u.lastLoginAt ? fmtWhen(u.lastLoginAt) : 'never signed in'),
      el('td', {},
        u.mustChange ? el('span.pill.new', {}, 'must set password') : null,
        u.locked ? el('span.pill.conflict', {}, 'locked') : null,
        u.disabled ? el('span.pill', {}, 'disabled') : null),
      el('td.r', {},
        el('button.btn.small.ghost', { onclick: () => act('reset') }, 'Reset password'), ' ',
        u.locked ? el('button.btn.small.ghost', { onclick: () => act('unlock', 'Unlocked.') }, 'Unlock') : null, ' ',
        u.envAdmin ? null : el('button.btn.small.ghost', {
          onclick: () => act(u.disabled ? 'enable' : 'disable', u.disabled ? 'Enabled.' : 'Disabled.'),
        }, u.disabled ? 'Enable' : 'Disable'))));
  }
  uc.append(el('div', { style: 'overflow:auto' }, el('table', {},
    el('thead', {}, el('tr', {}, el('th', {}, 'Leader'), el('th', {}, 'Role'),
      el('th', {}, 'Last signed in'), el('th', {}, ''), el('th.r', {}, ''))), ubody)));

  const nn = el('input', { type: 'text', placeholder: 'Name' });
  const ne = el('input', { type: 'email', placeholder: 'leader@example.org', autocomplete: 'off' });
  const nr = el('select', {}, el('option', { value: 'leader' }, 'Leader'), el('option', { value: 'admin' }, 'Admin'));
  uc.append(el('h3', { style: 'margin-top:18px' }, 'Add a leader'),
    el('div.grid2', {},
      el('div', {}, el('label', {}, 'Name'), nn),
      el('div', {}, el('label', {}, 'E-mail'), ne),
      el('div', {}, el('label', {}, 'Role'), nr)),
    el('div.actions', {}, el('button.btn', {
      onclick: async () => {
        try {
          const r = await api('/api/users', { method: 'POST', body: { name: nn.value, email: ne.value, role: nr.value } });
          await render();
          showTempPassword(r.user.email, r.tempPassword);
        } catch (e) { toast(e.message, true); }
      },
    }, 'Create account')),
    el('p.small.muted', {}, 'They get a one-time password, shown once on this screen — read it to them yourself. '
      + 'They must replace it when they first sign in.'));
  frag.append(uc);

  // --- behaviour -------------------------------------------------------
  const s = state.settings;
  frag.append(el('div.card', {}, el('h3', {}, 'Behaviour'),
    el('label.inline', {},
      el('input', {
        type: 'checkbox',
        checked: s.auto_propose !== false,
        onchange: async (ev) => {
          await api('/api/settings', { method: 'POST', body: { auto_propose: ev.target.checked } });
          state.settings.auto_propose = ev.target.checked;
          toast('Saved.');
        },
      }),
      'Propose earned stars automatically on every sync'),
    el('p.small.muted', {}, 'Proposals always need a leader’s approval either way — this only controls whether '
      + 'the sync raises them for you.')));
  return frag;
}

/**
 * Show a one-time password until the admin explicitly dismisses it.
 *
 * This is the only moment the password exists in readable form — the server
 * keeps a scrypt hash and nothing else, so a dismissal that happens by
 * accident means issuing a new one. Three consequences for this dialog:
 *
 *   - it lives on <body>, NOT inside #view. The first version rendered into
 *     #view and the caller then re-rendered the page, which cleared it within
 *     milliseconds — the password flashed past and was gone.
 *   - it is not a toast and does not time out.
 *   - Escape and a click on the backdrop deliberately do NOT close it. For
 *     almost any dialog that is hostile; here, the cost of a stray keypress
 *     is a password nobody can read back.
 */
function showTempPassword(email, password) {
  const existing = $('.modal-root');
  if (existing) existing.remove();
  const previousFocus = document.activeElement;

  const value = el('p.credential', { tabindex: '0' }, password);
  const copyBtn = el('button.btn', {
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(password);
        copyBtn.textContent = 'Copied';
      } catch {
        // No clipboard permission (or an insecure origin) — select it so the
        // admin can copy by hand rather than being told nothing happened.
        const r = document.createRange();
        r.selectNodeContents(value);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        copyBtn.textContent = 'Selected — press Ctrl+C';
      }
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 4000);
    },
  }, 'Copy');

  const close = () => {
    root.remove();
    document.removeEventListener('keydown', onKey, true);
    if (previousFocus && previousFocus.focus) previousFocus.focus();
  };
  const doneBtn = el('button.btn.ghost', { onclick: close }, 'Done — I have saved it');

  const dialog = el('div.modal', {
    role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'otp-title',
  },
  el('h3', { id: 'otp-title' }, 'One-time password'),
  el('p', {}, 'For ', el('strong', {}, email), '. Read it to them now — ',
    el('strong', {}, 'it cannot be shown again.')),
  value,
  el('p.small.muted', {}, 'They will be asked to replace it the first time they sign in. '
    + 'If it is lost, issue a new one with “Reset password”.'),
  el('div.actions', {}, copyBtn, doneBtn));

  // Keep Tab inside the dialog, and swallow Escape.
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return; }
    if (e.key !== 'Tab') return;
    const focusable = [copyBtn, doneBtn, value];
    const i = focusable.indexOf(document.activeElement);
    if (i === -1) { e.preventDefault(); copyBtn.focus(); return; }
    const next = e.shiftKey ? i - 1 : i + 1;
    if (next < 0 || next >= focusable.length) {
      e.preventDefault();
      focusable[e.shiftKey ? focusable.length - 1 : 0].focus();
    }
  }
  document.addEventListener('keydown', onKey, true);

  const root = el('div.modal-root', {}, dialog);
  document.body.append(root);
  copyBtn.focus();
}

// ----------------------------------------------------------------- start ---
async function refreshCounts() {
  try {
    const { proposals } = await api('/api/proposals?status=proposed');
    const b = $('#review-count');
    b.textContent = String(proposals.length);
    b.hidden = proposals.length === 0;
  } catch { /* the page will say so */ }
}

async function start() {
  const me = await api('/api/me');
  state.user = me.user;
  state.troop = me.troop;
  state.settings = me.settings || {};
  $('#login-screen').hidden = true;
  $('#app').hidden = false;
  $('#troop-name').textContent = me.troop.name;
  $('#who').textContent = `${me.user.name} · ${me.user.role}`;
  for (const b of document.querySelectorAll('#tabs button[data-admin]')) b.hidden = me.user.role !== 'admin';
  await refreshCounts();
  render();
}

(async () => {
  try {
    await start();
  } catch (e) {
    if (e.status === 403 && e.data && e.data.error === 'password_change_required') {
      showLogin('Sign in again to set your password.');
    } else {
      showLogin();
    }
    try {
      const h = await (await fetch('/health')).json();
      $('#login-troop').textContent = h.troop ? `Trail Life ${h.troop}` : 'Trail Life Troop';
    } catch { /* leave the default */ }
  }
})();
