const NOTE_GRADIENT = 'linear-gradient(180deg, #8b9099, #393d44)';

const $ = (id) => document.getElementById(id);
const list = $('list');
const search = $('search');
let pages = [];

function showMsg(text) {
  $('msg').textContent = text;
  $('msg').hidden = false;
}

async function addToActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const msg = { type: 'add-note', text: '' };
  try {
    await chrome.tabs.sendMessage(tab.id, msg);
    window.close();
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await chrome.tabs.sendMessage(tab.id, msg);
      window.close();
    } catch {
      showMsg("Chrome doesn't allow notes on this page (chrome:// pages, the Web Store, new tab page, and built-in PDF viewer are blocked).");
    }
  }
}

async function load() {
  const all = await chrome.storage.local.get(null);
  pages = Object.entries(all)
    .filter(([k, v]) => k.startsWith('notes:') && v?.notes?.length)
    .map(([key, v]) => ({ key, ...v }));
  draw();
}

function draw() {
  const q = search.value.trim().toLowerCase();
  const rows = [];
  for (const p of pages) {
    for (const n of p.notes) {
      const hay = ((n.text || '') + ' ' + (p.title || '') + ' ' + p.url).toLowerCase();
      if (q && !hay.includes(q)) continue;
      rows.push({ p, n });
    }
  }
  rows.sort((a, b) => (b.n.updated || 0) - (a.n.updated || 0));

  list.replaceChildren();
  if (!rows.length) {
    const e = document.createElement('div');
    e.className = 'empty-state';
    e.textContent = q ? 'No notes match your search.' : 'No notes yet. Add one to this page above.';
    list.appendChild(e);
  }

  for (const { p, n } of rows) {
    const item = document.createElement('div');
    item.className = 'item';

    const stripe = document.createElement('div');
    stripe.className = 'stripe';
    stripe.style.background = NOTE_GRADIENT;

    const body = document.createElement('div');
    body.className = 'body';
    body.title = 'Open page';
    const text = document.createElement('div');
    text.className = 'text' + (n.text?.trim() ? '' : ' empty');
    text.textContent = n.text?.trim() ? n.text.slice(0, 200) : '(empty note)';
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${p.title || p.url} · ${new Date(n.updated).toLocaleDateString()}`;
    body.append(text, meta);
    body.addEventListener('click', () => chrome.tabs.create({ url: p.url }));

    const del = document.createElement('button');
    del.className = 'del';
    del.title = 'Delete note';
    del.textContent = '×';
    del.addEventListener('click', () => deleteNote(p, n.id));

    item.append(stripe, body, del);
    list.appendChild(item);
  }

  const total = pages.reduce((s, p) => s + p.notes.length, 0);
  $('count').textContent = `${total} note${total === 1 ? '' : 's'} on ${pages.length} page${pages.length === 1 ? '' : 's'}`;
}

async function deleteNote(page, id) {
  if (!confirm('Delete this note?')) return;
  const remaining = page.notes.filter((n) => n.id !== id);
  if (remaining.length) {
    await chrome.storage.local.set({ [page.key]: { ...stripKey(page), notes: remaining } });
  } else {
    await chrome.storage.local.remove(page.key);
  }
  load();
}

function stripKey(p) {
  const { key, ...rest } = p;
  return rest;
}

async function exportNotes() {
  const all = await chrome.storage.local.get(null);
  const data = Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith('notes:')));
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sticky-notes-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

$('add').addEventListener('click', addToActiveTab);
$('export').addEventListener('click', exportNotes);
search.addEventListener('input', draw);
load();
