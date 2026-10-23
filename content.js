// Hover Notes — content script
// Notes render inside a Shadow DOM so page CSS can't break them (and vice versa).
// Behaviour: each note rests as a small text-free grey tab, expands on hover,
// stays open while you type, and collapses when you move away.
//
// Two scopes:
//   - All pages (default): one note that follows you to every site and every
//     page change — e.g. a scratchpad you copy/paste from.
//   - This page only: stays on the page (origin + path) where it was created.

(() => {
  if (window.__stickyNotesExt) return;
  window.__stickyNotesExt = true;

  const TAB = 34;          // collapsed tab size (px)
  const CLOSE_DELAY = 350; // ms after mouse leaves before collapsing
  const GKEY = 'notes:__global__';

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
      resize: both; min-width: 180px; min-height: 120px;
      transform-origin: top left; animation: pop .14s ease-out;
    }
    @keyframes pop { from { opacity: 0; transform: scale(.94); } to { opacity: 1; transform: none; } }
    .tab { flex: 1; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 3px; }
    .tab i { display: block; width: 14px; height: 2px; border-radius: 1px; background: rgba(255,255,255,.8); }
    .tab i:last-child { width: 9px; margin-right: 5px; }
    .head {
      display: flex; align-items: center; gap: 4px; padding: 5px 6px 5px 10px;
      background: rgba(0,0,0,.2); cursor: grab; user-select: none; flex: 0 0 auto;
    }
    .head:active { cursor: grabbing; }
    .scope { flex: 1; font-size: 10px; letter-spacing: .3px; opacity: .6; white-space: nowrap; }
    .btn {
      all: unset; width: 22px; height: 22px; line-height: 22px; text-align: center;
      border-radius: 5px; cursor: pointer; font-size: 14px; color: #e9ecef;
    }
    .btn:hover { background: rgba(255,255,255,.16); }
    .toggle { opacity: .4; font-size: 12px; }
    .toggle.on { opacity: 1; background: rgba(255,255,255,.18); }
    textarea {
      all: unset; flex: 1; box-sizing: border-box; width: 100%; padding: 8px 10px;
      white-space: pre-wrap; overflow: auto; font: inherit; color: inherit; caret-color: #fff;
    }
    textarea::placeholder { color: rgba(255,255,255,.45); }
    textarea::selection { background: rgba(255,255,255,.3); }
    .foot { font-size: 10px; opacity: .55; padding: 0 10px 5px; text-align: right; flex: 0 0 auto; }
  `;

  let key = pageKey();
  let pageNotes = [];
  let globalNotes = [];
  const lastWritten = {}; // storage key -> JSON last written/seen by this tab
  let saveTimer = null;
  let zTop = 1;

  const host = document.createElement('div');
  host.id = 'sticky-notes-ext';
  host.style.cssText =
    'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CSS;
  root.appendChild(style);

  function pageKey() {
    return 'notes:' + location.origin + location.pathname;
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const listFor = (n) => (n.global ? globalNotes : pageNotes);

  function ensureHost() {
    if (!host.isConnected) document.documentElement.appendChild(host);
  }

  // Write only the storage keys whose contents actually changed, so a tab with
  // a stale copy never overwrites newer notes saved from another tab.
  function writeKey(k, arr, meta) {
    const s = JSON.stringify(arr);
    if (s === lastWritten[k]) return;
    lastWritten[k] = s;
    if (arr.length) chrome.storage.local.set({ [k]: { ...meta, notes: arr } });
    else chrome.storage.local.remove(k);
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        writeKey(key, pageNotes, { url: location.href, title: document.title });
        writeKey(GKEY, globalNotes, { url: '', title: 'All pages', global: true });
      } catch {
        // Extension was reloaded/updated; this old script can no longer save.
      }
    }, 250);
  }

  function buildNote(n, startOpen = false) {
    const el = document.createElement('div');
    el.className = 'note closed';
    el.dataset.scope = n.global ? 'global' : 'page';
    el.style.zIndex = ++zTop;

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

    const scopeLabel = document.createElement('span');
    scopeLabel.className = 'scope';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn';
    copyBtn.title = 'Copy note text';
    copyBtn.textContent = '⧉';

    const globeBtn = document.createElement('button');
    globeBtn.className = 'btn toggle';
    globeBtn.textContent = '🌐';

    const pinBtn = document.createElement('button');
    pinBtn.className = 'btn toggle' + (n.pinned ? ' on' : '');
    pinBtn.title = 'Keep open';
    pinBtn.textContent = '📌';

    const delBtn = document.createElement('button');
    delBtn.className = 'btn';
    delBtn.title = 'Delete note';
    delBtn.textContent = '×';

    head.append(scopeLabel, copyBtn, globeBtn, pinBtn, delBtn);

    const showScope = () => {
      scopeLabel.textContent = n.global ? 'ALL PAGES' : 'THIS PAGE';
      globeBtn.classList.toggle('on', !!n.global);
      globeBtn.title = n.global
        ? 'Showing on all pages — click to keep on this page only'
        : 'Showing on this page only — click to show on all pages';
    };
    showScope();

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

    // --- Open / close -------------------------------------------------------
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

    // --- Typing -------------------------------------------------------------
    // Block page keyboard shortcuts (YouTube, Gmail, X, Grok, etc.) while typing.
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
      save();
    });

    // --- Copy (one click, e.g. a reusable prompt for Grok) -------------------
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

    // --- Scope toggle (all pages <-> this page) -----------------------------
    globeBtn.addEventListener('click', () => {
      const from = listFor(n);
      from.splice(from.indexOf(n), 1);
      n.global = !n.global;
      listFor(n).push(n);
      el.dataset.scope = n.global ? 'global' : 'page';
      showScope();
      save();
    });

    // --- Pin ----------------------------------------------------------------
    pinBtn.addEventListener('click', () => {
      n.pinned = !n.pinned;
      pinBtn.classList.toggle('on', n.pinned);
      pinBtn.title = n.pinned ? 'Unpin (auto-hide)' : 'Keep open';
      save();
    });

    // --- Delete -------------------------------------------------------------
    delBtn.addEventListener('click', () => {
      if (n.text.trim() && !confirm('Delete this sticky note?')) return;
      const list = listFor(n);
      const i = list.indexOf(n);
      if (i > -1) list.splice(i, 1);
      if (el._ro) el._ro.disconnect();
      el.remove();
      save();
    });

    // Bring to front
    el.addEventListener('pointerdown', () => (el.style.zIndex = ++zTop));

    // --- Drag by header -----------------------------------------------------
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
        save();
        if (!el.matches(':hover')) scheduleClose();
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
    });

    // --- Persist resize (only while expanded) -------------------------------
    el._ro = new ResizeObserver(() => {
      if (!isOpen()) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (w > TAB && h > TAB && (w !== n.w || h !== n.h)) {
        n.w = w;
        n.h = h;
        save();
      }
    });
    el._ro.observe(el);

    placeClosed();
    if (n.pinned || startOpen) open();

    el._ta = ta;
    return el;
  }

  // Re-render one scope only, so a page change never disturbs a global note
  // you're typing in.
  function render(scope) {
    // Removing sibling notes can make Chrome drop focus from a note you're
    // typing in — remember it and restore it afterwards.
    const active = root.activeElement;
    const sel = active?.tagName === 'TEXTAREA' ? [active.selectionStart, active.selectionEnd] : null;

    root.querySelectorAll(`.note[data-scope="${scope}"]`).forEach((el) => {
      if (el._ro) el._ro.disconnect();
      el.remove();
    });
    const list = scope === 'global' ? globalNotes : pageNotes;
    if (list.length) ensureHost();
    list.forEach((n) => root.appendChild(buildNote(n)));

    if (!active?.isConnected) return;
    const restore = () => {
      if (active.isConnected && root.activeElement !== active) {
        active.focus({ preventScroll: true });
        if (sel) active.setSelectionRange(sel[0], sel[1]);
      }
    };
    restore();
    // Chrome's focus fix-up runs after the DOM change, so check again shortly.
    requestAnimationFrame(restore);
    setTimeout(restore, 50);
  }

  function addNote(text = '') {
    const offset = ((pageNotes.length + globalNotes.length) % 6) * 24;
    const n = {
      id: uid(),
      text,
      x: Math.max(10, innerWidth - 280 - offset),
      y: 80 + offset,
      w: 260,
      h: 220,
      pinned: false,
      global: true, // default: follows you to every page
      created: Date.now(),
      updated: Date.now()
    };
    globalNotes.push(n);
    ensureHost();
    const el = buildNote(n, true);
    root.appendChild(el);
    el._ta.focus();
    save();
  }

  function loadPage() {
    const k = key;
    chrome.storage.local.get(k).then((r) => {
      if (k !== key) return; // URL changed again while loading
      pageNotes = (r[k]?.notes || []).map((n) => ({ ...n, global: false }));
      lastWritten[k] = JSON.stringify(r[k]?.notes || []);
      render('page');
    });
  }

  function loadGlobal() {
    chrome.storage.local.get(GKEY).then((r) => {
      globalNotes = (r[GKEY]?.notes || []).map((n) => ({ ...n, global: true }));
      lastWritten[GKEY] = JSON.stringify(r[GKEY]?.notes || []);
      render('global');
    });
  }

  // Sync changes made elsewhere: popup, or another tab (keeps the global note
  // identical in every open tab).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [k, scope] of [[key, 'page'], [GKEY, 'global']]) {
      if (!changes[k]) continue;
      const incoming = changes[k].newValue?.notes || [];
      const s = JSON.stringify(incoming);
      if (s === lastWritten[k]) continue; // our own write
      lastWritten[k] = s;
      if (scope === 'global') globalNotes = incoming.map((n) => ({ ...n, global: true }));
      else pageNotes = incoming.map((n) => ({ ...n, global: false }));
      render(scope);
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === 'add-note') {
      addNote(msg.text || '');
      reply({ ok: true });
    }
  });

  // Single-page apps (Grok, X, Gmail…) change the URL without reloading.
  // Only page-scoped notes are swapped; global notes stay put.
  setInterval(() => {
    const k = pageKey();
    if (k !== key) {
      key = k;
      loadPage();
    }
  }, 700);

  loadGlobal();
  loadPage();
})();
