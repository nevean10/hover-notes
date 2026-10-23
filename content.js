// Sticky Notes — content script
// Notes render inside a Shadow DOM so page CSS can't break them (and vice versa).
// Behaviour: each note rests as a small text-free grey tab, expands on hover,
// stays open while you type, and collapses when you move away.
// The pin button keeps a note permanently open.

(() => {
  if (window.__stickyNotesExt) return;
  window.__stickyNotesExt = true;

  const TAB = 34;          // collapsed tab size (px)
  const CLOSE_DELAY = 350; // ms after mouse leaves before collapsing

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
    .grip { flex: 1; height: 14px; }
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

  let key = pageKey();
  let notes = [];
  let lastWritten = '';
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

  function ensureHost() {
    if (!host.isConnected) document.documentElement.appendChild(host);
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        if (notes.length) {
          lastWritten = JSON.stringify(notes);
          chrome.storage.local.set({
            [key]: { url: location.href, title: document.title, notes }
          });
        } else {
          lastWritten = '[]';
          chrome.storage.local.remove(key);
        }
      } catch {
        // Extension was reloaded/updated; this old script can no longer save.
      }
    }, 250);
  }

  function buildNote(n, startOpen = false) {
    const el = document.createElement('div');
    el.className = 'note closed';
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
    const grip = document.createElement('div');
    grip.className = 'grip';

    const pinBtn = document.createElement('button');
    pinBtn.className = 'btn pin' + (n.pinned ? ' on' : '');
    pinBtn.title = 'Keep open';
    pinBtn.textContent = '📌';

    const delBtn = document.createElement('button');
    delBtn.className = 'btn';
    delBtn.title = 'Delete note';
    delBtn.textContent = '×';

    head.append(grip, pinBtn, delBtn);

    // Body
    const ta = document.createElement('textarea');
    ta.value = n.text || '';
    ta.placeholder = 'Type a note…';
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
      notes = notes.filter((x) => x.id !== n.id);
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

  function render() {
    root.querySelectorAll('.note').forEach((el) => {
      if (el._ro) el._ro.disconnect();
      el.remove();
    });
    if (notes.length) ensureHost();
    notes.forEach((n) => root.appendChild(buildNote(n)));
  }

  function addNote(text = '') {
    const offset = (notes.length % 6) * 24;
    const n = {
      id: uid(),
      text,
      x: Math.max(10, innerWidth - 280 - offset),
      y: 80 + offset,
      w: 250,
      h: 210,
      pinned: false,
      created: Date.now(),
      updated: Date.now()
    };
    notes.push(n);
    ensureHost();
    const el = buildNote(n, true);
    root.appendChild(el);
    el._ta.focus();
    save();
  }

  function load() {
    chrome.storage.local.get(key).then((r) => {
      notes = r[key]?.notes || [];
      lastWritten = JSON.stringify(notes);
      render();
    });
  }

  // Sync changes made elsewhere (popup deletes, another tab on the same page).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[key]) return;
    const incoming = changes[key].newValue?.notes || [];
    const s = JSON.stringify(incoming);
    if (s === lastWritten) return; // our own write
    notes = incoming;
    lastWritten = s;
    render();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === 'add-note') {
      addNote(msg.text || '');
      reply({ ok: true });
    }
  });

  // Single-page apps (X, Gmail, etc.) change the URL without reloading.
  setInterval(() => {
    const k = pageKey();
    if (k !== key) {
      key = k;
      load();
    }
  }, 1000);

  load();
})();
