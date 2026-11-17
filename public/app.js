(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const PALETTE = ['#e5b567', '#6cc5b0', '#9d8cf0', '#e87d8a', '#6aa9f0', '#b6d36a', '#e59a5c', '#c48be0'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Per-browser conveniences only; the page works without storage.
  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem(k);
        return v == null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch {}
    },
  };

  const state = {
    entries: [],
    byPath: new Map(),
    colors: new Map(),
    kind: store.get('kind', 'all'),
    group: null,
    q: '',
    hits: null, // Map path -> { count, snippets } while a search is active
    path: null,
    seen: store.get('seen', null),
  };

  // ---------- helpers ----------
  const kindLabel = (k) => {
    const s = k.replace(/[-_]+/g, ' ').replace(/\bpr\b/gi, 'PR');
    return s.charAt(0).toUpperCase() + s.slice(1);
  };

  function dateParts(d) {
    const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return { short: d, dow: '', long: d, bucket: d.slice(0, 4) };
    const [y, mo, da] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const dow = DAYS[new Date(Date.UTC(y, mo - 1, da)).getUTCDay()];
    return {
      short: `${MONTHS[mo - 1]} ${da}`,
      dow,
      long: `${dow}, ${MONTHS_LONG[mo - 1]} ${da}, ${y}`,
      bucket: `${MONTHS_LONG[mo - 1]} ${y}`,
    };
  }

  const isUnread = (e) => state.seen[e.path] !== e.mtime;

  function markSeen(e) {
    if (!isUnread(e)) return;
    state.seen[e.path] = e.mtime;
    store.set('seen', state.seen);
  }

  function visible() {
    return state.entries.filter(
      (e) =>
        (state.kind === 'all' || e.kind === state.kind) &&
        (!state.group || e.group === state.group) &&
        (!state.hits || state.hits.has(e.path)),
    );
  }

  function highlight(text) {
    let out = esc(text);
    const terms = state.q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return out;
    const re = new RegExp('(' + terms.map((t) => esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi');
    return out.replace(re, '<mark>$1</mark>');
  }

  // ---------- rendering ----------
  function renderRail() {
    const kinds = [...new Set(state.entries.map((e) => e.kind))].sort();
    kinds.forEach((k, i) => state.colors.set(k, PALETTE[i % PALETTE.length]));
    if (state.kind !== 'all' && !kinds.includes(state.kind)) state.kind = 'all';

    const row = (id, label, list, color) => {
      const unread = list.filter(isUnread).length;
      return `<button class="kind${state.kind === id ? ' on' : ''}" data-kind="${esc(id)}" style="--c:${color}">
        <span class="sw"></span><span class="name">${esc(label)}</span>
        ${unread ? `<span class="new" title="${unread} unread">${unread}</span>` : ''}
        <span class="n">${list.length}</span></button>`;
    };
    $('#kinds').innerHTML =
      row('all', 'All reports', state.entries, 'var(--faint)') +
      kinds.map((k) => row(k, kindLabel(k), state.entries.filter((e) => e.kind === k), state.colors.get(k))).join('');
  }

  function renderGroups() {
    const pool = state.entries.filter((e) => state.kind === 'all' || e.kind === state.kind);
    const groups = [...new Set(pool.map((e) => e.group).filter(Boolean))].sort();
    if (state.group && !groups.includes(state.group)) state.group = null;
    $('#groups').innerHTML =
      state.kind === 'all' || !groups.length
        ? ''
        : [`<button class="chip${state.group ? '' : ' on'}" data-group="">All</button>`]
            .concat(groups.map((g) => `<button class="chip${state.group === g ? ' on' : ''}" data-group="${esc(g)}">${esc(g)}</button>`))
            .join('');
  }

  function renderList() {
    renderGroups();
    const list = visible();
    $('#count').textContent = state.hits
      ? `${list.length} report${list.length === 1 ? '' : 's'} matching “${state.q}”`
      : `${list.length} report${list.length === 1 ? '' : 's'}`;

    if (!list.length) {
      $('#items').innerHTML = `<div class="empty">${
        state.hits ? 'Nothing matches that search.' : 'No reports found under the reports root.'
      }</div>`;
      return;
    }

    let html = '';
    let bucket = null;
    for (const e of list) {
      const d = dateParts(e.date);
      if (d.bucket !== bucket) {
        bucket = d.bucket;
        html += `<div class="month">${esc(bucket)}</div>`;
      }
      const tag = state.kind === 'all' ? [kindLabel(e.kind), e.group].filter(Boolean).join(' · ') : e.group;
      const hit = state.hits && state.hits.get(e.path);
      const unread = isUnread(e);
      html += `<a class="item${e.path === state.path ? ' on' : ''}${unread ? '' : ' read'}" href="#${encodeURI(e.path)}" data-path="${esc(e.path)}" style="--c:${state.colors.get(e.kind)}">
        <div class="item-top">
          ${unread ? '<span class="unread" title="Unread or updated"></span>' : ''}
          <span class="date">${esc(d.short)}</span><span class="dow">${esc(d.dow)}</span>
          ${hit ? `<span class="hits">${hit.count} hit${hit.count === 1 ? '' : 's'}</span>` : ''}
          ${tag ? `<span class="tag">${esc(tag)}</span>` : ''}
        </div>
        ${
          hit
            ? hit.snippets.map((s) => `<div class="snip">${highlight(s)}</div>`).join('')
            : `<div class="sum">${esc(e.summary || e.title || '')}</div>`
        }
      </a>`;
    }
    $('#items').innerHTML = html;
  }

  function renderNav() {
    const list = visible();
    const i = list.findIndex((e) => e.path === state.path);
    $('#newer').disabled = i <= 0;
    $('#older').disabled = i < 0 || i >= list.length - 1;
  }

  function step(delta) {
    const list = visible();
    if (!list.length) return;
    const i = list.findIndex((e) => e.path === state.path);
    const next = list[i < 0 ? 0 : Math.min(list.length - 1, Math.max(0, i + delta))];
    if (next && next.path !== state.path) location.hash = encodeURI(next.path);
  }

  marked.use({
    gfm: true,
    renderer: {
      // Raw HTML in a report is shown as text, never rendered.
      html(token) {
        return esc(typeof token === 'string' ? token : token.text);
      },
    },
  });

  let openSeq = 0;
  async function openReport(path) {
    const e = state.byPath.get(path);
    if (!e) return;
    const seq = ++openSeq;
    state.path = path;
    document.body.classList.add('reading');

    let data;
    try {
      const res = await fetch('/api/report?path=' + encodeURIComponent(path));
      if (!res.ok) throw new Error(res.status);
      data = await res.json();
    } catch {
      if (seq !== openSeq) return;
      $('#doc').innerHTML = '<div class="empty">Could not load this report.</div>';
      return;
    }
    if (seq !== openSeq) return;

    const doc = $('#doc');
    // A run of `**Label:** value` lines is a metadata block: keep one line each.
    const md = data.markdown.replace(/\n(?=\*\*[^*\n]+:\*\*)/g, '  \n');
    doc.innerHTML = marked.parse(md);
    doc.querySelectorAll('table').forEach((t) => {
      const wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      t.replaceWith(wrap);
      wrap.appendChild(t);
    });
    doc.querySelectorAll('a[href]').forEach((a) => {
      if (/^https?:/i.test(a.getAttribute('href'))) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      } else {
        a.removeAttribute('href');
      }
    });

    const heads = [...doc.querySelectorAll('h2, h3')];
    $('#toc').innerHTML = heads.length > 2 ? '<div class="toc-h">On this page</div>' : '';
    if (heads.length > 2) {
      heads.forEach((h) => {
        const b = document.createElement('button');
        b.className = h.tagName === 'H3' ? 'l3' : 'l2';
        b.textContent = h.textContent;
        b.addEventListener('click', () => h.scrollIntoView({ behavior: 'smooth', block: 'start' }));
        $('#toc').appendChild(b);
      });
    }

    const d = dateParts(e.date);
    const color = state.colors.get(e.kind);
    const mins = Math.max(1, Math.round(e.words / 220));
    const updated = new Date(e.mtime).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    $('#crumbs').innerHTML = `<span class="k" style="--c:${color}">${esc(kindLabel(e.kind))}</span>
      ${e.group ? `<span class="sep">/</span><span>${esc(e.group)}</span>` : ''}
      <span class="sep">/</span><span>${esc(d.long)}</span>
      <span class="meta">${mins} min read · updated ${esc(updated)}</span>`;
    document.title = `${d.short} · ${kindLabel(e.kind)}`;
    $('#scroll').scrollTop = 0;

    markSeen(e);
    renderRail();
    renderList();
    renderNav();
    const on = document.querySelector('.item.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  }

  function route() {
    let path = '';
    try {
      path = decodeURIComponent(location.hash.slice(1));
    } catch {}
    if (state.byPath.has(path)) return openReport(path);
    state.path = null;
    document.body.classList.remove('reading');
    // On a wide screen the reader pane is always visible, so fill it with the newest report.
    const first = visible()[0];
    if (first && window.matchMedia('(min-width: 721px)').matches) {
      history.replaceState(null, '', '#' + encodeURI(first.path));
      return openReport(first.path);
    }
    $('#doc').innerHTML = '';
    $('#crumbs').innerHTML = '';
    $('#toc').innerHTML = '';
    document.title = 'Reports';
    renderList();
    renderNav();
  }

  async function loadIndex(initial) {
    let data;
    try {
      const res = await fetch('/api/index');
      data = await res.json();
    } catch {
      if (initial) $('#items').innerHTML = '<div class="empty">Could not reach the reports server.</div>';
      return;
    }
    const changed = JSON.stringify(data.entries) !== JSON.stringify(state.entries);
    if (!changed && !initial) return;
    state.entries = data.entries;
    state.byPath = new Map(data.entries.map((e) => [e.path, e]));
    $('#root').textContent = data.root;

    if (!state.seen) {
      // First visit: only the last few days count as unread, not the whole archive.
      const dates = [...new Set(data.entries.map((e) => e.date))].slice(0, 3);
      state.seen = {};
      for (const e of data.entries) if (!dates.includes(e.date)) state.seen[e.path] = e.mtime;
      store.set('seen', state.seen);
    }

    renderRail();
    if (initial) return route();
    renderList();
    renderNav();
    const cur = state.byPath.get(state.path);
    if (cur && isUnread(cur) && $('#scroll').scrollTop < 40) openReport(cur.path); // open report was rewritten
  }

  // ---------- events ----------
  $('#kinds').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-kind]');
    if (!b) return;
    state.kind = b.dataset.kind;
    state.group = null;
    store.set('kind', state.kind);
    renderRail();
    renderList();
    const list = visible();
    if (list.length && !list.some((e) => e.path === state.path) && window.matchMedia('(min-width: 721px)').matches) {
      location.hash = encodeURI(list[0].path);
    }
    renderNav();
    $('#items').scrollTop = 0;
  });

  $('#groups').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-group]');
    if (!b) return;
    state.group = b.dataset.group || null;
    renderList();
    renderNav();
  });

  let timer = null;
  let searchSeq = 0;
  $('#q').addEventListener('input', (ev) => {
    clearTimeout(timer);
    const q = ev.target.value.trim();
    timer = setTimeout(async () => {
      const seq = ++searchSeq;
      state.q = q;
      if (!q) {
        state.hits = null;
      } else {
        try {
          const res = await fetch('/api/search?q=' + encodeURIComponent(q));
          const data = await res.json();
          if (seq !== searchSeq) return;
          state.hits = new Map(data.hits.map((h) => [h.path, h]));
        } catch {
          return;
        }
      }
      renderList();
      renderNav();
      $('#items').scrollTop = 0;
    }, 160);
  });

  $('#newer').addEventListener('click', () => step(-1));
  $('#older').addEventListener('click', () => step(1));
  $('#back').addEventListener('click', () => {
    history.pushState(null, '', location.pathname);
    state.path = null;
    document.body.classList.remove('reading');
    renderList();
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (ev.key === 'Escape' && typing) {
      $('#q').value = '';
      $('#q').dispatchEvent(new Event('input'));
      $('#q').blur();
      return;
    }
    if (typing) return;
    if (ev.key === '/') {
      ev.preventDefault();
      $('#q').focus();
    } else if (ev.key === 'j') step(1);
    else if (ev.key === 'k') step(-1);
  });

  window.addEventListener('hashchange', route);
  window.addEventListener('focus', () => loadIndex(false));
  setInterval(() => loadIndex(false), 60000);

  loadIndex(true);
})();
