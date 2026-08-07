// background.js — local-only. No network calls, no external server.
// Everything this extension needs to remember (bookmarks, sidecar receiver
// registry) lives in chrome.storage.local, scoped to this browser profile.
//
// EXCEPT the block at the bottom of this file marked DEV-ONLY, added
// 2026-08-07 purely to make live iteration less painful (a manual
// chrome://extensions reload for every content.js change was real
// friction during active development). It is NOT part of the extension's
// design and MUST be deleted -- not just disabled -- before this is ever
// actually published. Toggling DEV_MODE to false stops it from running,
// but the code (and the private URL it talks to) would still be sitting
// in the source for anyone to read. Delete the whole block.

async function persistBookmark(label, text, sourceUrl) {
  const key = 'bookmarks:' + sourceUrl;
  const result = await chrome.storage.local.get(key);
  const entries = result[key] || [];
  if (entries.some(e => e.label === label && e.text === text)) return;
  entries.unshift({ label, text, timestamp: new Date().toISOString() });
  if (entries.length > 50) entries.length = 50;
  await chrome.storage.local.set({ [key]: entries });
}

// ── Ping-gated orphan tab sweep (pull-side tab refresh) ────────────────
// A new-generation service worker (manual chrome://extensions reload,
// browser restart) can't reach content scripts left running from the OLD
// generation — chrome.tabs.sendMessage rejects/times out talking to them.
// That unreachability IS the signal: ping every open bot tab and reload
// only the ones that don't answer. Runs on worker boot only.
const BOT_TAB_PATTERNS = [
  'https://claude.ai/*',
  'https://gemini.google.com/*',
  'https://chatgpt.com/*',
  'https://chat.openai.com/*',
];

function _pingTab(tabId, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(false); } }, timeoutMs);
    try {
      chrome.tabs.sendMessage(tabId, { action: 'crpb-ping' }, (resp) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(!chrome.runtime.lastError && !!resp?.alive);
      });
    } catch (_e) {
      if (!settled) { settled = true; clearTimeout(timer); resolve(false); }
    }
  });
}

async function refreshOrphanedBotTabs() {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ url: BOT_TAB_PATTERNS });
  } catch (_e) { return; }
  for (const tab of (tabs || [])) {
    if (tab.discarded || tab.status !== 'complete') continue;
    const alive = await _pingTab(tab.id);
    if (!alive) chrome.tabs.reload(tab.id);
  }
}

chrome.runtime.onInstalled.addListener(() => refreshOrphanedBotTabs());
chrome.runtime.onStartup.addListener(() => refreshOrphanedBotTabs());

// ── Sidecar tab registry — pure chrome.tabs messaging, same browser only ──

const STORAGE_KEY = 'sidecarReceivers';

async function getReceivers() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return new Set(result[STORAGE_KEY] || []);
}

async function setReceivers(set) {
  await chrome.storage.local.set({ [STORAGE_KEY]: [...set] });
}

async function registerReceiver(tabId) {
  const receivers = await getReceivers();
  receivers.add(tabId);
  await setReceivers(receivers);
}

async function unregisterReceiver(tabId) {
  const receivers = await getReceivers();
  receivers.delete(tabId);
  await setReceivers(receivers);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  unregisterReceiver(tabId);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'reload') {
    chrome.runtime.reload();
    return;
  }

  if (msg.action === 'sidecar-register') {
    registerReceiver(sender.tab.id).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.action === 'sidecar-unregister') {
    unregisterReceiver(sender.tab.id).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.action === 'log-event') {
    // Local-only: no dispatch-history network call. persistBookmark is this
    // extension's own chrome.storage.local record (the restore path's
    // source) — unrelated to any server.
    if (msg.label === 'bookmark' || msg.label === 'reply') {
      persistBookmark(msg.label, msg.sourceText, msg.sourceUrl);
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === 'migrate-bookmarks') {
    // /new → /chat/<id> hop: re-key this session's entries under the real
    // chat URL and drop the pre-canonical key.
    (async () => {
      const toKey = 'bookmarks:' + msg.toUrl;
      const result = await chrome.storage.local.get(toKey);
      const entries = result[toKey] || [];
      for (const e of msg.entries || []) {
        entries.unshift({ label: e.label, text: e.text, timestamp: new Date().toISOString() });
      }
      if (entries.length > 50) entries.length = 50;
      await chrome.storage.local.set({ [toKey]: entries });
      await chrome.storage.local.remove('bookmarks:' + msg.fromUrl);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.action === 'get-bookmarks') {
    const key = 'bookmarks:' + msg.sourceUrl;
    chrome.storage.local.get(key).then((result) => {
      sendResponse({ entries: result[key] || [] });
    });
    return true;
  }

  if (msg.action === 'sidecar-send') {
    (async () => {
      const receivers = await getReceivers();
      const validReceivers = [...receivers].filter(id => id !== sender.tab.id);

      if (validReceivers.length === 0) {
        // No receiver registered — open claude.ai/new, register it, then deliver.
        const newTab = await chrome.tabs.create({ url: 'https://claude.ai/new', active: true });

        await new Promise((resolve) => {
          const deadline = setTimeout(resolve, 15000);
          chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
            if (tabId === newTab.id && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener);
              clearTimeout(deadline);
              resolve();
            }
          });
        });

        await registerReceiver(newTab.id);
        await new Promise(r => setTimeout(r, 1200));

        chrome.tabs.sendMessage(newTab.id, {
          action: 'sidecar-receive',
          text: msg.text,
          submit: msg.submit !== false,
        }).catch(() => {});

        sendResponse({ ok: true, count: 1 });
        return;
      }

      for (const tabId of validReceivers) {
        chrome.tabs.sendMessage(tabId, {
          action: 'sidecar-receive',
          text: msg.text,
          submit: msg.submit !== false,
        }).catch(() => {
          unregisterReceiver(tabId);
        });
      }
      sendResponse({ ok: true, count: validReceivers.length });
    })();

    return true;
  }

  if (msg.action === 'sidecar-status') {
    getReceivers().then((receivers) => {
      sendResponse({ isReceiver: receivers.has(sender.tab.id) });
    });
    return true;
  }
});

// DEV-ONLY reload listener lives in its own file, dev-reload.js, which the
// PUBLISHED build simply does not contain -- an absent file can't be
// accidentally left enabled the way a forgotten boolean flag can. Publishing
// this extension means not copying dev-reload.js, nothing else to remember.
try { importScripts('dev-reload.js'); } catch (_e) { /* absent in a published build — expected, not an error */ }
