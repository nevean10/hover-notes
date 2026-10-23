// Sticky Notes — content script
// Notes render inside a Shadow DOM so page CSS can't break them (and vice versa).
// Behaviour: each note rests as a small text-free grey tab, expands on hover,
// stays open while you type, and collapses when you move away.
//
// Scope: every note lives in one of three buckets —
//   site : every page on this website only, e.g. all of x.com (default)
//   page : this exact URL path only
//   all  : every website

(() => {
  if (window.__stickyNotesExt) return;
  window.__stickyNotesExt = true;

  const TAB = 34;          // collapsed tab size (px)
  const CLOSE_DELAY = 350; // ms after mouse leaves before collapsing
  const SCOPES = ['page', 'site', 'all'];
  // Click the scope label to cycle: All sites -> This site -> This page -> All sites
  const NEXT_SCOPE = { all: 'site', site: 'page', page: 'all' };
  const DEFAULT_SCOPE = 'site'; // new notes stay on the website you made them on
  const GKEY = 'notes:__global__'; // kept from v1.2 so existing all-sites notes survive

  const CSS = `
    :host { all: initial; }
    .note {
      position: fixed; display: flex; flex-direction: column; box-sizing: border-box;
      background: linear-gradient(150deg, #8b9099 0%, #5e636c 45%, #393d44 100%);
      color: #f1f3f5; border: 1px solid rgba(255,255,255,.14); border-radius: 10px;
      overflow: hidden; pointer-events: auto;
      box-shadow: 0 10px 26px rgba(0,0,0,.35), 0 1px 3px rgba(0,0,0,.25);
      font: 13px/1.45 -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
    }
    /* Resting state: small tab, no words */
    .note.closed {
      width: ${TAB}px !important; height: ${TAB}px !important;
      resize: none; cursor: pointer; opacity: .8; transition: opacity .15s;
    }
    .note.closed:hover { opacity: 1; }
    .note.closed > :not(.tab) { display: none; }
    .note.open > .tab { display: none; }
    /* Expanded state */
    .note.open {
      resize: both; min-width: 200px; min-height: 120px;
      transform-origin: top left; animation: pop .14s ease-out;
    }
    @keyframes pop { from { opacity: 0; transform: scale(.94); } to { opacity: 1; transform: none; } }
    .tab { flex: 1; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 3px; }
    .tab i { display: block; width: 14px; height: 2px; border-radius: 1px; background: rgba(255,255,255,.8); }
    .tab i:last-child { width: 9px; margin-right: 5px; }
    .head {
      display: flex; align-items: center; gap: 4px; padding: 5px 6px 5px 8px;
      background: rgba(0,0,0,.2); cursor: grab; user-select: none; flex: 0 0 auto;
    }
    .head:active { cursor: grabbing; }
    .grip { flex: 1; height: 14px; }
    .scope {
      all: unset; cursor: pointer; font-size: 10px; font-weight: 700; letter-spacing: .05em;
      text-transform: uppercase; padding: 2px 8px; border-radius: 9px; color: #f1f3f5;
      background: rgba(255,255,255,.14);
    }
    .scope:hover { background: rgba(255,255,255,.24); }
    .scope.wide { background: rgba(120,190,255,.35); }
    .btn {
      all: unset; width: 22px; height: 22px; line-height: 22px; text-align: center;
      border-radius: 5px; cursor: pointer; font-size: 14px; color: #e9ecef;
    }
    .btn:hover { background: rgba(255,255,255,.16); }
    .pin { opacity: .4; font-size: 12px; }
    .pin.on { opacity: 1; background: rgba(255,255,255,.18); }
    textarea {
      all: unset; flex: 1; box-sizing: border-box; width: 100%; padding: 8px 10px;
      white-space: pre-wrap; overflow: auto; font: inherit; color: inherit; caret-color: #fff;
    }
    textarea::placeholder { color: rgba(255,255,255,.45); }
    textarea::selection { background: rgba(255,255,255,.3); }
    .foot { font-size: 10px; opacity: .55; padding: 0 10px 5px; text-align: right; flex: 0 0 auto; }
  `;

  function keyFor(scope) {
    if (scope === 'page') return 'notes:' + location.origin + location.pathname;
    if (scope === 'site') return 'notes:site:' + location.origin;
    return GKEY;
  }

  const siteName = () => location.host.replace(/^www\./, '');

  // One bucket per scope: { key, url, notes, lastWritten, timer }
  const buckets = {};
  for (const s of SCOPES) {
    buckets[s] = { key: keyFor(s), url: location.href, notes: [], lastWritten: '', timer: null };
  }

  let zTop = 1;

  const host = document.createElement('div');
  host.id = 'sticky-notes-ext';
  host.style.cssText =
    'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CSS;
  root.appendChild(style);

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function ensureHost() {
    if (!host.isConnected) document.documentElement.appendChild(host);
  }

  // --- Storage --------------------------------------------------------------
  function recordMeta(scope, b) {
    if (scope === 'page') return { url: b.url, title: document.title };
    if (scope === 'site') return { url: location.origin + '/', title: siteName(), site: true };
    return { url: '', title: 'All sites', global: true };
  }

  // Write only when this bucket actually changed, so a tab holding a stale copy
  // never overwrites newer notes saved from another tab.
  function write(scope) {
    const b = buckets[scope];
    clearTimeout(b.timer);
    b.timer = null;
    const s = JSON.stringify(b.notes);
    if (s === b.lastWritten) return;
    try {
      if (b.notes.length) {
        b.lastWritten = s;
        chrome.storage.local.set({ [b.key]: { ...recordMeta(scope, b), notes: b.notes } });
      } else {
        b.lastWritten = '[]';
        chrome.storage.local.remove(b.key);
      }
    } catch {
      // Extension was reloaded/updated; this old script can no longer save.
    }
  }

  function save(scope) {
    const b = buckets[scope];
    clearTimeout(b.timer);
    b.timer = setTimeout(() => write(scope), 250);
  }

  function flush(scope) {
    if (buckets[scope].timer) write(scope);
  }

  // --- Note UI --------------------------------------------------------------
  function buildNote(n, initialScope, startOpen = false) {
    let scope = initialScope;
    const el = document.createElement('div');
    el.className = 'note closed';
    el.style.zIndex = ++zTop;
    el._scope = scope;

    let dragging = false;
    let closeTimer = null;

    // Collapsed tab (no text, just a small icon)
    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.title = 'Sticky note';
    tab.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));

    // Header
    const head = document.createElement('div');
    head.className = 'head';
    const grip = document.createElement('div');
    grip.className = 'grip';

    const scopeBtn = document.createElement('button');
    scopeBtn.className = 'scope';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn';
    copyBtn.title = 'Copy note text';
    copyBtn.textContent = '⧉';

    const pinBtn = document.createElement('button');
    pinBtn.className = 'btn pin' + (n.pinned ? ' on' : '');
    pinBtn.title = n.pinned ? 'Unpin (auto-hide)' : 'Keep open';
    pinBtn.textContent = '📌';

    const delBtn = document.createElement('button');
    delBtn.className = 'btn';
    delBtn.title = 'Delete note';
    delBtn.textContent = '×';

    head.append(grip, scopeBtn, copyBtn, pinBtn, delBtn);

    // Body
    const ta = document.createElement('textarea');
    ta.value = n.text || '';
    ta.placeholder = 'Type or paste…';
    ta.spellcheck = true;

    const foot = document.createElement('div');
    foot.className = 'foot';
    const stamp = () => (foot.textContent = new Date(n.updated).toLocaleString());
    stamp();

    el.append(tab, head, ta, foot);

    // --- Scope ---------------------------------------------------------------
    function paintScope() {
      scopeBtn.textContent = { page: 'This page', site: siteName() + ' only', all: 'All sites' }[scope];
      scopeBtn.classList.toggle('wide', scope === 'all');
      scopeBtn.title = {
        all: 'Shown on every website. Click: only on ' + siteName(),
        site: 'Shown on every page of ' + siteName() + ' only. Click: this page only',
        page: 'Shown on this page only. Click: every website'
      }[scope];
    }
    paintScope();

    scopeBtn.addEventListener('click', () => {
      const from = scope;
      const to = NEXT_SCOPE[from];
      buckets[from].notes = buckets[from].notes.filter((x) => x.id !== n.id);
      buckets[to].notes.push(n);
      scope = to;
      el._scope = to;
      paintScope();
      save(from);
      save(to);
    });

    // --- Copy ----------------------------------------------------------------
    copyBtn.addEventListener('click', async () => {
      const text = ta.value;
      let ok = false;
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch {
        try {
          ta.focus();
          ta.select();
          ok = document.execCommand('copy');
          ta.setSelectionRange(text.length, text.length);
        } catch {}
      }
      copyBtn.textContent = ok ? '✓' : '!';
      copyBtn.title = ok ? 'Copied' : 'Copy failed — select the text and press Ctrl+C';
      setTimeout(() => {
        copyBtn.textContent = '⧉';
        copyBtn.title = 'Copy note text';
      }, 1200);
    });

    // --- Open / close --------------------------------------------------------
    const isOpen = () => el.classList.contains('open');

    function placeClosed() {
      el.style.left = clamp(n.x, 0, innerWidth - TAB - 4) + 'px';
      el.style.top = clamp(n.y, 0, innerHeight - TAB - 4) + 'px';
      el.style.width = '';
      el.style.height = '';
    }

    function open() {
      clearTimeout(closeTimer);
      if (isOpen()) return;
      el.classList.replace('closed', 'open');
      el.style.width = n.w + 'px';
      el.style.height = n.h + 'px';
      // Shift into view if the note would spill off the right/bottom edge.
      el.style.left = clamp(n.x, 0, Math.max(0, innerWidth - n.w - 8)) + 'px';
      el.style.top = clamp(n.y, 0, Math.max(0, innerHeight - n.h - 8)) + 'px';
      el.style.zIndex = ++zTop;
    }

    function close(force = false) {
      if (!isOpen()) return;
      if (!force && (n.pinned || dragging || root.activeElement === ta)) return;
      el.classList.replace('open', 'closed');
      placeClosed();
    }

    function scheduleClose() {
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => {
        if (!el.matches(':hover')) close();
      }, CLOSE_DELAY);
    }

    el.addEventListener('mouseenter', open);
    el.addEventListener('mouseleave', scheduleClose);
    tab.addEventListener('click', () => {
      open();
      ta.focus();
    });

    // --- Typing --------------------------------------------------------------
    // Block page keyboard shortcuts (YouTube, Gmail, X, etc.) while typing.
    ['keydown', 'keyup', 'keypress'].forEach((t) =>
      ta.addEventListener(t, (e) => e.stopPropagation())
    );
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        ta.blur();
        if (!n.pinned) close(true);
      }
    });
    ta.addEventListener('focus', open);
    ta.addEventListener('blur', scheduleClose);
    ta.addEventListener('input', () => {
      n.text = ta.value;
      n.updated = Date.now();
      stamp();
      save(scope);
    });

    // --- Pin -----------------------------------------------------------------
    pinBtn.addEventListener('click', () => {
      n.pinned = !n.pinned;
      pinBtn.classList.toggle('on', n.pinned);
      pinBtn.title = n.pinned ? 'Unpin (auto-hide)' : 'Keep open';
      save(scope);
    });

    // --- Delete --------------------------------------------------------------
    delBtn.addEventListener('click', () => {
      if (n.text.trim() && !confirm('Delete this sticky note?')) return;
      buckets[scope].notes = buckets[scope].notes.filter((x) => x.id !== n.id);
      if (el._ro) el._ro.disconnect();
      el.remove();
      save(scope);
    });

    // Bring to front
    el.addEventListener('pointerdown', () => (el.style.zIndex = ++zTop));

    // --- Drag by header ------------------------------------------------------
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      e.preventDefault();
      dragging = true;
      const offX = e.clientX - el.offsetLeft;
      const offY = e.clientY - el.offsetTop;
      head.setPointerCapture(e.pointerId);
      const move = (ev) => {
        el.style.left = clamp(ev.clientX - offX, 0, innerWidth - 80) + 'px';
        el.style.top = clamp(ev.clientY - offY, 0, innerHeight - 30) + 'px';
      };
      const up = () => {
        head.removeEventListener('pointermove', move);
        head.removeEventListener('pointerup', up);
        dragging = false;
        n.x = el.offsetLeft;
        n.y = el.offsetTop;
        save(scope);
        if (!el.matches(':hover')) scheduleClose();
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
    });

    // --- Persist resize (only while expanded) --------------------------------
    el._ro = new ResizeObserver(() => {
      if (!isOpen()) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (w > TAB && h > TAB && (w !== n.w || h !== n.h)) {
        n.w = w;
        n.h = h;
        save(scope);
      }
    });
    el._ro.observe(el);

    placeClosed();
    if (n.pinned || startOpen) open();

    el._ta = ta;
    return el;
  }

  // Re-draw only the notes of one scope, leaving the others untouched
  // (so a Site/All note you're typing in survives page navigation).
  function render(scope) {
    root.querySelectorAll('.note').forEach((el) => {
      if (el._scope !== scope) return;
      if (el._ro) el._ro.disconnect();
      el.remove();
    });
    const list = buckets[scope].notes;
    if (list.length) ensureHost();
    list.forEach((n) => root.appendChild(buildNote(n, scope)));
  }

  function addNote(text = '') {
    const b = buckets[DEFAULT_SCOPE];
    const offset = (root.querySelectorAll('.note').length % 6) * 24;
    const n = {
      id: uid(),
      text,
      x: Math.max(10, innerWidth - 280 - offset),
      y: 80 + offset,
      w: 260,
      h: 210,
      pinned: false,
      created: Date.now(),
      updated: Date.now()
    };
    b.notes.push(n);
    ensureHost();
    const el = buildNote(n, DEFAULT_SCOPE, true);
    root.appendChild(el);
    el._ta.focus();
    save(DEFAULT_SCOPE);
  }

  function load(scope) {
    const b = buckets[scope];
    const key = b.key;
    chrome.storage.local.get(key).then((r) => {
      if (b.key !== key) return; // navigated away while loading
      b.notes = r[key]?.notes || [];
      b.lastWritten = JSON.stringify(b.notes);
      render(scope);
    });
  }

  // Sync changes made elsewhere (popup deletes, other tabs, scope moves).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const scope of SCOPES) {
      const b = buckets[scope];
      if (!changes[b.key]) continue;
      const incoming = changes[b.key].newValue?.notes || [];
      const s = JSON.stringify(incoming);
      if (s === b.lastWritten) continue; // our own write
      b.notes = incoming;
      b.lastWritten = s;
      render(scope);
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === 'add-note') {
      addNote(msg.text || '');
      reply({ ok: true });
    }
  });

  // Single-page apps (X, Gmail, etc.) change the URL without reloading.
  // Only page-scoped notes swap; Site/All notes stay put.
  setInterval(() => {
    const b = buckets.page;
    const k = keyFor('page');
    if (k !== b.key) {
      flush('page');
      b.key = k;
      b.url = location.href;
      b.notes = [];
      load('page');
    }
  }, 500);

  SCOPES.forEach(load);
})();
