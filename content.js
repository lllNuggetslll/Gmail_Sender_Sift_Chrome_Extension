(function () {
  'use strict';
  console.log('[SenderSift] content script loaded on', location.href);
  if (document.getElementById('sift-root')) return;

  const PALETTE = ['#1a73e8', '#d93025', '#188038', '#e37400', '#8430ce', '#00838f', '#c2185b', '#5e35b1', '#00695c', '#ef6c00'];

  const QUICK_QUERIES = [
    ['in:inbox', 'Inbox'],
    ['in:inbox category:promotions', 'Promotions'],
    ['in:inbox category:updates', 'Updates'],
    ['in:inbox category:social', 'Social'],
    ['in:inbox category:forums', 'Forums'],
    ['in:inbox is:unread', 'Unread'],
    ['', 'All mail'],
  ];

  const state = {
    token: null,
    query: 'in:inbox',
    year: '', // '' = any year, else a 4-digit year string
    sortMode: 'count',
    groups: [],
    selected: new Set(), // gmailIds
    scanning: false,
  };

  // Combines the free-text query with the year filter (if any) into the
  // actual string sent to the Gmail API. Gmail's before: is exclusive, so
  // a year Y becomes after:Y/1/1 before:(Y+1)/1/1 to cover the whole year.
  function buildQuery() {
    let q = state.query.trim();
    if (state.year) {
      const y = parseInt(state.year, 10);
      q = `${q} after:${y}/1/1 before:${y + 1}/1/1`.trim();
    }
    return q;
  }

  function el(tag, attrs, html) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (k === 'class') node.className = v;
      else node.setAttribute(k, v);
    });
    if (html !== undefined) node.innerHTML = html;
    return node;
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  let panelEl = null;

  function buildUI() {
    panelEl = el('div', { id: 'sift-root', class: 'sift-hidden' });
    panelEl.innerHTML = `
      <div class="sift-head">
        <strong>Sender Sift</strong>
        <button id="sift-close" class="sift-icon-btn" title="Close">&times;</button>
      </div>
      <div class="sift-chips" id="sift-chips"></div>
      <div class="sift-controls">
        <input id="sift-query" type="text" value="${escapeHtml(state.query)}" spellcheck="false">
        <select id="sift-year" title="Filter to a single year"></select>
        <button id="sift-scan" class="sift-btn sift-primary">Scan</button>
      </div>
      <div class="sift-sort">
        <span>Sort:</span>
        <button class="sift-sort-btn active" data-mode="count">Most emails</button>
        <button class="sift-sort-btn" data-mode="alpha">A &rarr; Z</button>
      </div>
      <div id="sift-progress" class="sift-progress-wrap sift-hidden">
        <div class="sift-progress-bar" id="sift-progress-bar"></div>
        <div id="sift-progress-text" class="sift-progress-text"></div>
      </div>
      <div id="sift-body" class="sift-body">
        <div class="sift-empty">Click Scan to group your inbox by sender.</div>
      </div>
      <div class="sift-footer">
        <span id="sift-selcount">0 selected</span>
        <button id="sift-archive" class="sift-btn" disabled>Archive</button>
        <button id="sift-delete" class="sift-btn sift-danger" disabled>Trash</button>
      </div>
    `;
    document.body.appendChild(panelEl);

    const toggle = el('button', { id: 'sift-toggle', title: 'Sender Sift' }, '&#9993;');
    document.body.appendChild(toggle);
    toggle.addEventListener('click', () => panelEl.classList.toggle('sift-hidden'));

    const chips = panelEl.querySelector('#sift-chips');
    QUICK_QUERIES.forEach(([q, label]) => {
      const chip = el('button', { class: 'sift-chip', 'data-q': q }, escapeHtml(label));
      chip.addEventListener('click', () => {
        panelEl.querySelector('#sift-query').value = q;
        state.query = q;
        runScan();
      });
      chips.appendChild(chip);
    });

    const yearSelect = panelEl.querySelector('#sift-year');
    const nowYear = new Date().getFullYear();
    let yearOptions = '<option value="">Any year</option>';
    for (let y = nowYear; y >= nowYear - 15; y--) {
      yearOptions += `<option value="${y}">${y}</option>`;
    }
    yearSelect.innerHTML = yearOptions;
    yearSelect.value = state.year;
    yearSelect.addEventListener('change', () => {
      state.year = yearSelect.value;
    });

    panelEl.querySelector('#sift-close').addEventListener('click', () => panelEl.classList.add('sift-hidden'));
    panelEl.querySelector('#sift-scan').addEventListener('click', () => {
      if (state.scanning) {
        send({ type: 'STOP_SCAN' });
        return;
      }
      state.query = panelEl.querySelector('#sift-query').value.trim();
      runScan();
    });
    panelEl.querySelectorAll('.sift-sort-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.sortMode = btn.dataset.mode;
        panelEl.querySelectorAll('.sift-sort-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        lastClickedGroupIndex = null;
        lastClickedItemIndex = null;
        renderGroups();
      });
    });
    panelEl.querySelector('#sift-archive').addEventListener('click', () => bulkAction('archive'));
    panelEl.querySelector('#sift-delete').addEventListener('click', () => bulkAction('delete'));

    connectProgress();
    restoreIfAny();
  }

  function connectProgress() {
    try {
      const port = chrome.runtime.connect({ name: 'sift-progress' });
      port.onMessage.addListener((msg) => {
        const wrap = document.getElementById('sift-progress');
        const bar = document.getElementById('sift-progress-bar');
        const text = document.getElementById('sift-progress-text');
        if (!wrap) return;
        wrap.classList.remove('sift-hidden');
        const pct = msg.total ? Math.min(100, Math.round((msg.done / msg.total) * 100)) : (msg.phase === 'listing' ? 5 : 0);
        bar.style.width = pct + '%';
        text.textContent = msg.phase === 'listing' ? 'Listing messages…'
          : msg.phase === 'stopped' ? `Stopped — ${msg.done} / ${msg.total} scanned`
          : `${msg.done} / ${msg.total} scanned`;
        if (msg.phase === 'done' || msg.phase === 'stopped') setTimeout(() => wrap.classList.add('sift-hidden'), 600);
      });
      port.onDisconnect.addListener(() => setTimeout(connectProgress, 1000));
    } catch (e) {
      setTimeout(connectProgress, 2000);
    }
  }

  function send(message) {
    return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
  }

  async function ensureToken() {
    if (state.token) return state.token;
    const resp = await send({ type: 'AUTH' });
    if (resp.error) throw new Error(resp.error);
    state.token = resp.token;
    return state.token;
  }

  function updateScanButton() {
    const btn = document.getElementById('sift-scan');
    if (!btn) return;
    btn.textContent = state.scanning ? 'Stop' : 'Scan';
    btn.classList.toggle('sift-danger', state.scanning);
    btn.classList.toggle('sift-primary', !state.scanning);
  }

  async function runScan() {
    if (state.scanning) return;
    state.scanning = true;
    updateScanButton();
    const body = document.getElementById('sift-body');
    body.innerHTML = '<div class="sift-empty">Scanning…</div>';
    try {
      const token = await ensureToken();
      const resp = await send({ type: 'SCAN', token, query: buildQuery(), maxMessages: 3000 });
      if (resp.error) throw new Error(resp.error);
      state.groups = resp.groups || [];
      state.selected.clear();
      lastClickedGroupIndex = null;
      lastClickedItemIndex = null;
      renderGroups();
      if (resp.stopped) {
        const note = document.createElement('div');
        note.className = 'sift-summary';
        note.textContent = state.groups.length
          ? 'Stopped early — showing partial results.'
          : 'Stopped before any results came back.';
        document.getElementById('sift-body').prepend(note);
      }
    } catch (err) {
      body.innerHTML = `<div class="sift-empty">Error: ${escapeHtml(err.message)}</div>`;
    } finally {
      state.scanning = false;
      updateScanButton();
    }
  }

  function sortedGroups() {
    const groups = state.groups.slice();
    if (state.sortMode === 'count') {
      groups.sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name));
    } else {
      groups.sort((a, b) => a.name.localeCompare(b.name));
    }
    return groups;
  }

  function renderGroups() {
    const body = document.getElementById('sift-body');
    const groups = sortedGroups();
    if (groups.length === 0) {
      body.innerHTML = '<div class="sift-empty">No messages matched.</div>';
      updateFooter();
      return;
    }

    const totalMsgs = groups.reduce((n, g) => n + g.items.length, 0);
    let html = `<div class="sift-summary">${totalMsgs} emails &middot; ${groups.length} senders</div>`;

    groups.forEach((g, i) => {
      const color = PALETTE[i % PALETTE.length];
      const initial = (g.name || g.email || '?').trim()[0].toUpperCase();
      const ids = g.items.map((m) => m.gmailId);
      const allSelected = ids.length > 0 && ids.every((id) => state.selected.has(id));
      const someSelected = !allSelected && ids.some((id) => state.selected.has(id));
      const unsubHref = g.unsubHttp || '';

      html += `
        <div class="sift-group" data-key="${escapeHtml(g.email || g.name)}">
          <div class="sift-group-head">
            <label class="sift-check-wrap"><input type="checkbox" class="sift-group-check" data-ids='${JSON.stringify(ids)}' ${allSelected ? 'checked' : ''} ${someSelected ? 'data-indeterminate="1"' : ''}></label>
            <span class="sift-avatar" style="background:${color}">${escapeHtml(initial)}</span>
            <span class="sift-arrow">&#9656;</span>
            <div class="sift-group-name">
              <div class="sift-name">${escapeHtml(g.name || g.email)}</div>
              ${g.email && g.email !== (g.name || '').toLowerCase() ? `<div class="sift-email">${escapeHtml(g.email)}</div>` : ''}
            </div>
            ${unsubHref ? `<a class="sift-unsub" href="${escapeHtml(unsubHref)}" target="_blank" rel="noopener noreferrer">Unsubscribe</a>` : ''}
            <span class="sift-count ${g.unreadCount ? 'sift-has-unread' : ''}">${g.items.length}</span>
          </div>
          <div class="sift-group-items">
            ${g.items.slice(0, 50).map((m) => `
              <div class="sift-item">
                <label class="sift-check-wrap"><input type="checkbox" class="sift-item-check" data-id="${escapeHtml(m.gmailId)}" ${state.selected.has(m.gmailId) ? 'checked' : ''}></label>
                <span class="sift-item-subject ${m.unread ? 'sift-unread' : ''}">${escapeHtml(m.subject)}</span>
              </div>
            `).join('')}
            ${g.items.length > 50 ? `<div class="sift-more">+ ${g.items.length - 50} more (still included when you check this sender)</div>` : ''}
          </div>
        </div>
      `;
    });

    body.innerHTML = html;
    bindGroupEvents();
    updateFooter();
  }

  // Anchors for shift-click range selection. Reset whenever the rendered
  // list they index into changes shape (new scan, re-sort) so a stale
  // anchor from a previous render can't point at the wrong row.
  let lastClickedGroupIndex = null;
  let lastClickedItemIndex = null;

  function bindGroupEvents() {
    document.querySelectorAll('.sift-group-head').forEach((head) => {
      head.addEventListener('click', (e) => {
        if (e.target.matches('input, a')) return;
        head.closest('.sift-group').classList.toggle('sift-open');
      });
    });

    const groupBoxes = Array.from(document.querySelectorAll('.sift-group-check'));
    groupBoxes.forEach((cb, idx) => {
      if (cb.dataset.indeterminate) cb.indeterminate = true;
      let shiftHeld = false;
      // Listen on the padded wrapper, not just the input: clicks in the
      // wrapper's padding fire on the label (then the browser re-fires a
      // click on the input), and neither must reach the row's expand/collapse
      // handler. Shift state is captured from whichever click passes through.
      cb.closest('.sift-check-wrap').addEventListener('click', (e) => {
        e.stopPropagation();
        shiftHeld = e.shiftKey;
      });
      cb.addEventListener('change', () => {
        const checked = cb.checked;
        const applyIds = (box) => {
          const ids = JSON.parse(box.dataset.ids);
          ids.forEach((id) => (checked ? state.selected.add(id) : state.selected.delete(id)));
        };
        if (shiftHeld && lastClickedGroupIndex !== null && groupBoxes[lastClickedGroupIndex]) {
          const [start, end] = [lastClickedGroupIndex, idx].sort((a, b) => a - b);
          for (let i = start; i <= end; i++) applyIds(groupBoxes[i]);
        } else {
          applyIds(cb);
        }
        lastClickedGroupIndex = idx;
        renderGroups();
      });
    });

    const itemBoxes = Array.from(document.querySelectorAll('.sift-item-check'));
    itemBoxes.forEach((cb, idx) => {
      let shiftHeld = false;
      cb.closest('.sift-check-wrap').addEventListener('click', (e) => {
        e.stopPropagation();
        shiftHeld = e.shiftKey;
      });
      cb.addEventListener('change', () => {
        const checked = cb.checked;
        const affectedGroups = new Set();
        const applyOne = (box) => {
          box.checked = checked;
          if (checked) state.selected.add(box.dataset.id);
          else state.selected.delete(box.dataset.id);
          affectedGroups.add(box.closest('.sift-group'));
        };
        if (shiftHeld && lastClickedItemIndex !== null && itemBoxes[lastClickedItemIndex]) {
          const [start, end] = [lastClickedItemIndex, idx].sort((a, b) => a - b);
          for (let i = start; i <= end; i++) applyOne(itemBoxes[i]);
        } else {
          applyOne(cb);
        }
        lastClickedItemIndex = idx;
        affectedGroups.forEach((g) => syncGroupCheckbox(g));
        updateFooter();
      });
    });
  }

  function syncGroupCheckbox(groupEl) {
    if (!groupEl) return;
    const parent = groupEl.querySelector('.sift-group-check');
    const ids = JSON.parse(parent.dataset.ids);
    const checkedCount = ids.filter((id) => state.selected.has(id)).length;
    parent.checked = checkedCount === ids.length;
    parent.indeterminate = checkedCount > 0 && checkedCount < ids.length;
  }

  function updateFooter() {
    document.getElementById('sift-selcount').textContent = `${state.selected.size} selected`;
    document.getElementById('sift-archive').disabled = state.selected.size === 0;
    document.getElementById('sift-delete').disabled = state.selected.size === 0;
  }

  async function bulkAction(action) {
    if (state.selected.size === 0) return;
    const label = action === 'delete' ? 'Trash' : 'Archive';
    if (!confirm(`${label} ${state.selected.size} email(s)? This is the same as ${label.toLowerCase()}ing them by hand in Gmail.`)) return;

    const ids = Array.from(state.selected);
    const addLabels = action === 'delete' ? ['TRASH'] : [];
    const removeLabels = ['INBOX'];

    try {
      const token = await ensureToken();
      const resp = await send({ type: 'MODIFY', token, ids, addLabels, removeLabels });
      if (resp.error) throw new Error(resp.error);

      const removed = new Set(ids);
      state.groups = state.groups
        .map((g) => ({ ...g, items: g.items.filter((m) => !removed.has(m.gmailId)) }))
        .filter((g) => g.items.length > 0);
      state.selected.clear();
      lastClickedGroupIndex = null;
      lastClickedItemIndex = null;
      renderGroups();
      showUndo(action, ids);
      persistForReload();
      // Gmail's own list is a client-side cache that doesn't see API-side label
      // changes until it refetches. A reload is the reliable way to force that;
      // persistForReload() restores the panel to its current state afterward.
      setTimeout(() => location.reload(), 150);
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  let undoTimer = null;
  function showUndo(action, ids) {
    const existing = document.getElementById('sift-toast');
    if (existing) existing.remove();
    if (undoTimer) clearTimeout(undoTimer);

    const toast = el('div', { id: 'sift-toast', class: 'sift-toast' },
      `<span>${ids.length} email(s) ${action === 'delete' ? 'trashed' : 'archived'}</span>
       <button id="sift-undo">Undo</button>`);
    document.body.appendChild(toast);
    document.getElementById('sift-undo').addEventListener('click', async () => {
      try {
        const token = await ensureToken();
        await send({
          type: 'MODIFY', token, ids,
          addLabels: ['INBOX'],
          removeLabels: action === 'delete' ? ['TRASH'] : [],
        });
      } catch (e) { /* best effort */ }
      toast.remove();
      location.reload();
    });
    undoTimer = setTimeout(() => toast.remove(), 15000);
  }

  function persistForReload() {
    try {
      sessionStorage.setItem('sift-state', JSON.stringify({
        open: panelEl && !panelEl.classList.contains('sift-hidden'),
        query: state.query,
        year: state.year,
        sortMode: state.sortMode,
        groups: state.groups,
      }));
    } catch (e) { /* storage unavailable, non-fatal */ }
  }

  function restoreIfAny() {
    try {
      const raw = sessionStorage.getItem('sift-state');
      if (!raw) return;
      sessionStorage.removeItem('sift-state');
      const saved = JSON.parse(raw);
      state.query = saved.query || state.query;
      state.year = saved.year || '';
      state.sortMode = saved.sortMode || state.sortMode;
      state.groups = saved.groups || [];
      const input = document.getElementById('sift-query');
      if (input) input.value = state.query;
      const yearSelect = document.getElementById('sift-year');
      if (yearSelect) yearSelect.value = state.year;
      if (saved.open) panelEl.classList.remove('sift-hidden');
      renderGroups();
    } catch (e) { /* nothing to restore */ }
  }

  // The panel is a self-contained set of fixed-position elements appended to
  // <body> — it never queries Gmail's own DOM for anything, so it doesn't
  // need to wait for Gmail's internal (and frequently-renamed) class names.
  // Just wait for <body> to exist, which document_idle already guarantees
  // in practice, with a short retry as a safety margin.
  function init() {
    if (document.body) {
      buildUI();
      return;
    }
    const ready = setInterval(() => {
      if (document.body) {
        clearInterval(ready);
        buildUI();
      }
    }, 200);
    setTimeout(() => clearInterval(ready), 15000);
  }

  init();
})();
