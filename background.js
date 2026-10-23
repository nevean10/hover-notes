// Sticky Notes — background service worker
// Handles: right-click menu, keyboard shortcut, and injecting the note script
// into tabs that were open before the extension was installed.

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'add-note',
    title: 'Add sticky note',
    contexts: ['page', 'selection']
  });
});

async function addNoteToTab(tabId, text = '') {
  const msg = { type: 'add-note', text };
  try {
    await chrome.tabs.sendMessage(tabId, msg);
    return true;
  } catch {
    // Content script not present yet (tab opened before install) -> inject, retry.
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      await chrome.tabs.sendMessage(tabId, msg);
      return true;
    } catch {
      return false; // chrome://, Web Store, PDF viewer etc. — Chrome blocks these.
    }
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'add-note' && tab?.id) {
    addNoteToTab(tab.id, info.selectionText || '');
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'new-note') return;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) addNoteToTab(tab.id);
});
