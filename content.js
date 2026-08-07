// Claude Composer Toolkit
// Two independent pieces sharing one page:
//  1. Reply/bookmark sidebar — select text in a response, bookmark your
//     place or quote it into a reply, jump back later. Multi-site (Claude,
//     Gemini, ChatGPT).
//  2. Composer macro buttons — one-click reply macros above the composer:
//     Explain/Clarify/Elaborate a selection or your last request, Expand/
//     Condense a selection or Claude's own last reply, plus a persistent
//     per-conversation verbosity level. Claude-only (see the SITE==='claude'
//     guard at the bottom) — the ProseMirror composer this drives has no
//     Gemini/ChatGPT equivalent wired up yet.
// Everything lives in chrome.storage.local. No account, no server, no
// network calls at all.

(function () {
  'use strict';

  // ────────────────────────────────────────────────────────────────────
  // SITE DETECTION
  // ────────────────────────────────────────────────────────────────────

  const SITE = location.hostname.includes('gemini.google.com') ? 'gemini'
             : (location.hostname.includes('chatgpt.com') || location.hostname.includes('chat.openai.com')) ? 'chatgpt'
             : 'claude';

  // ────────────────────────────────────────────────────────────────────
  // SELECTORS — per-site, not a stable contract.
  // Each value is a list; the first selector that matches wins.
  // Update when the host site changes its DOM.
  // ────────────────────────────────────────────────────────────────────

  const SITE_SEL = {
    claude: {
      ASSISTANT_TURN: [
        '[data-test-render-count]',
        '[data-testid*="assistant-message" i]',
        '[data-testid*="assistant-turn" i]',
        '[data-message-author-role="assistant"]',
      ],
      USER_MESSAGE: ['[data-testid="user-message"]'],
    },
    gemini: {
      ASSISTANT_TURN: ['model-response'],
      USER_MESSAGE: ['user-query'],
    },
    chatgpt: {
      ASSISTANT_TURN: ['[data-message-author-role="assistant"]'],
      USER_MESSAGE: ['[data-message-author-role="user"]'],
    },
  };

  const SEL = SITE_SEL[SITE];

  // ────────────────────────────────────────────────────────────────────
  // BOOKMARK STATE
  // ────────────────────────────────────────────────────────────────────

  const MAX_BOOKMARKS = 30;
  const TITLE_LENGTH = 60;

  const bookmarks = [];
  let restoredBookmarks = [];
  let nextId = 1;

  // ────────────────────────────────────────────────────────────────────
  // CAPTURING ANCHOR A
  // ────────────────────────────────────────────────────────────────────

  let lastSelection = null;

  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      hideSidecarBtns();
      return;
    }
    const text = sel.toString().trim();
    if (!text) return;

    const range = sel.getRangeAt(0);

    if (SITE === 'claude') {
      const inputEl = findInput();
      if (inputEl && inputEl.contains(range.startContainer)) return;

      const assistantTurn = closestMatching(range.startContainer, SEL.ASSISTANT_TURN);
      if (!assistantTurn) return;
      lastSelection = { text, range: range.cloneRange(), assistantTurn, timestamp: Date.now() };
      showSidecarBtns(lastSelection.range);
    } else {
      const assistantTurn = closestMatching(range.startContainer, SEL.ASSISTANT_TURN)
        || (range.startContainer.nodeType === Node.TEXT_NODE
          ? range.startContainer.parentElement
          : range.startContainer);
      lastSelection = { text, range: range.cloneRange(), assistantTurn, timestamp: Date.now() };
      showSidecarBtns(lastSelection.range);
    }
  });

  function closestMatching(node, selectorList) {
    let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (el) {
      for (const sel of selectorList) {
        try { if (el.matches(sel)) return el; } catch { /* skip invalid selector */ }
      }
      el = el.parentElement;
    }
    return null;
  }

  // ────────────────────────────────────────────────────────────────────
  // SELECTION ACTION BAR — unified for all sites
  // ────────────────────────────────────────────────────────────────────

  document.addEventListener('mousedown', (e) => {
    if (sidecarBtnContainer && !sidecarBtnContainer.contains(e.target)) hideSidecarBtns();
  });

  // ────────────────────────────────────────────────────────────────────
  // SIDECAR SEND — floating action buttons on selection
  // ────────────────────────────────────────────────────────────────────

  // "Explain" collided with the composer row's own Explain button before
  // this rename (Tod + Tab, 2026-08-07): same word, genuinely different
  // operations -- the composer row asks IN this conversation, this one
  // asks ASIDE, in another tab entirely, without disturbing the thread
  // you're in. "Ask aside" makes the destination part of the label instead
  // of relying on position (floating vs. fixed row) to carry the meaning.
  const SIDECAR_PROMPTS = [
    { label: 'Ask aside', prefix: 'Please explain this:\n\n' },
    { label: 'Define',  prefix: 'Please define this term or concept:\n\n' },
  ];

  let sidecarBtnContainer = null;
  let isReceiver = false;

  function ensureSidecarBtns() {
    if (sidecarBtnContainer) return sidecarBtnContainer;
    sidecarBtnContainer = document.createElement('div');
    sidecarBtnContainer.className = 'crpb-sidecar-btns';

    const replyBtn = document.createElement('button');
    replyBtn.className = 'crpb-sidecar-action';
    replyBtn.textContent = 'Reply';
    replyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!lastSelection || Date.now() - lastSelection.timestamp > 10000) return;
      logEvent('reply', lastSelection.text, window.location.href);
      createBookmark(lastSelection, 'reply');
      appendReply(lastSelection.text);
      hideSidecarBtns();
    });
    sidecarBtnContainer.appendChild(replyBtn);

    const bmBtn = document.createElement('button');
    bmBtn.className = 'crpb-sidecar-action';
    bmBtn.textContent = 'Bookmark';
    bmBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!lastSelection || Date.now() - lastSelection.timestamp > 10000) return;
      logEvent('bookmark', lastSelection.text, window.location.href);
      createBookmark(lastSelection, 'bookmark');
      hideSidecarBtns();
    });
    sidecarBtnContainer.appendChild(bmBtn);

    for (const { label, prefix } of SIDECAR_PROMPTS) {
      const btn = document.createElement('button');
      btn.className = 'crpb-sidecar-action crpb-sidecar-dispatch';
      btn.textContent = label;
      btn.dataset.prefix = prefix;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!lastSelection || Date.now() - lastSelection.timestamp > 10000) return;
        const text = btn.dataset.prefix + lastSelection.text;
        chrome.runtime.sendMessage({
          action: 'sidecar-send',
          text,
          submit: true,
        }, (resp) => {
          if (!resp || resp.count === 0) {
            showSidecarFeedback('No sidecar tab registered');
          }
        });
        hideSidecarBtns();
      });
      sidecarBtnContainer.appendChild(btn);
    }
    document.body.appendChild(sidecarBtnContainer);
    return sidecarBtnContainer;
  }

  function showSidecarBtns(range) {
    const container = ensureSidecarBtns();
    container.querySelectorAll('.crpb-sidecar-dispatch').forEach(btn => {
      btn.style.display = isReceiver ? 'none' : '';
    });
    const rect = range.getBoundingClientRect();
    container.style.top  = Math.max(8, rect.top - 90) + 'px';
    container.style.left = Math.min(rect.left, window.innerWidth - 200) + 'px';
    container.classList.add('crpb-sidecar-visible');
  }

  function hideSidecarBtns() {
    if (sidecarBtnContainer) sidecarBtnContainer.classList.remove('crpb-sidecar-visible');
  }

  function showSidecarFeedback(msg) {
    const fb = document.createElement('div');
    fb.className = 'crpb-sidecar-feedback';
    fb.textContent = msg;
    document.body.appendChild(fb);
    setTimeout(() => fb.remove(), 2500);
  }

  // ────────────────────────────────────────────────────────────────────
  // RECEIVER — accept incoming sidecar text and inject into input box
  // ────────────────────────────────────────────────────────────────────

  const INPUT_SELECTORS = [
    '[data-testid="chat-input"] .ProseMirror',
    'div[contenteditable="true"].ProseMirror',
    'fieldset div[contenteditable="true"]',
    'div[contenteditable="true"]',
    'textarea',
  ];

  const SUBMIT_SELECTORS = [
    'button[aria-label="Send message"]',
    'button[aria-label*="Send" i]',
    'button[type="submit"]',
  ];

  function findInput() {
    for (const sel of INPUT_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function findSubmit() {
    for (const sel of SUBMIT_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function chatgptPaste(input, text) {
    input.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
  }

  function injectAndSubmit(text) {
    const input = findInput();
    if (!input) {
      showSidecarFeedback('Could not find input box');
      return;
    }
    if (SITE === 'chatgpt') {
      chatgptPaste(input, text);
      setTimeout(() => {
        const btn = document.querySelector('button[data-testid="send-button"]');
        if (btn && !btn.disabled) btn.click();
      }, 150);
      return;
    }
    input.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
    setTimeout(() => {
      const submitBtn = findSubmit();
      if (submitBtn) {
        submitBtn.click();
      } else {
        input.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13,
          bubbles: true, cancelable: true,
        }));
      }
    }, 80);
  }

  function injectAndFill(text) {
    const input = findInput();
    if (!input) return;
    if (SITE === 'chatgpt') { chatgptPaste(input, text); return; }
    input.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
  }

  function appendReply(text) {
    let quoted = '> ' + text.trim().replace(/\n/g, '\n> ') + '\n\n';
    const input = findInput();
    if (!input) {
      console.warn('[CCT] appendReply: no composer matched INPUT_SELECTORS — paste dropped');
      return;
    }
    if (SITE === 'chatgpt') { chatgptPaste(input, quoted); return; }
    input.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    if (input.textContent.trim().length > 0) quoted = '\n\n' + quoted;
    document.execCommand('insertText', false, quoted);
  }

  function logEvent(label, sourceText, sourceUrl) {
    chrome.runtime.sendMessage({ action: 'log-event', label, sourceText, sourceUrl });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'crpb-ping') { sendResponse({ alive: true }); return; }
    if (msg.action === 'sidecar-receive') {
      if (msg.submit === false) {
        injectAndFill(msg.text);
      } else {
        injectAndSubmit(msg.text);
      }
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // SCROLL UTILS
  // ────────────────────────────────────────────────────────────────────

  function findScrollContainer(el) {
    let node = el.parentElement;
    while (node && node !== document.documentElement) {
      const ov = window.getComputedStyle(node).overflowY;
      if ((ov === 'auto' || ov === 'scroll') && node.scrollHeight > node.clientHeight) return node;
      node = node.parentElement;
    }
    return document.documentElement;
  }

  // ────────────────────────────────────────────────────────────────────
  // NAV — recency walk over bookmarks/replies + positional turn stepping
  // ────────────────────────────────────────────────────────────────────

  let navCursor = -1;

  function navEntries() {
    return [
      ...bookmarks.map(bm => ({ kind: 'live', bm })),
      ...restoredBookmarks.map(entry => ({ kind: 'restored', entry })),
    ];
  }

  function seatCursor(kind, item) {
    navCursor = navEntries().findIndex(e =>
      e.kind === kind && (kind === 'live' ? e.bm === item : e.entry === item));
  }

  function jumpToEntry(e) {
    if (e.kind === 'live') return jumpToA(e.bm);
    return jumpToRestored(e.entry);
  }

  function scrollChatToBottom() {
    let last = null;
    for (const s of [...SEL.USER_MESSAGE, ...SEL.ASSISTANT_TURN]) {
      try {
        const els = document.querySelectorAll(s);
        if (els.length) { last = els[els.length - 1]; break; }
      } catch { /* skip invalid selector */ }
    }
    const c = last ? findScrollContainer(last) : document.documentElement;
    c.scrollTo({ top: c.scrollHeight, behavior: 'smooth' });
  }

  function bumpNav() {
    if (!sidebarRoot) return;
    sidebarRoot.classList.remove('crpb-nav-bump');
    void sidebarRoot.offsetWidth;
    sidebarRoot.classList.add('crpb-nav-bump');
  }

  function navOlder() {
    const entries = navEntries();
    if (navCursor >= entries.length) navCursor = -1;
    if (!entries.length || navCursor >= entries.length - 1) { bumpNav(); return; }
    const next = navCursor + 1;
    navCursor = next;
    if (!jumpToEntry(entries[next])) {
      if (next + 1 < entries.length && jumpToEntry(entries[next + 1])) navCursor = next + 1;
      else bumpNav();
    }
  }

  function navNewer() {
    const entries = navEntries();
    if (navCursor >= entries.length) navCursor = -1;
    if (!entries.length) { bumpNav(); return; }
    if (navCursor <= 0) { navCursor = -1; scrollChatToBottom(); return; }
    const next = navCursor - 1;
    navCursor = next;
    if (!jumpToEntry(entries[next])) {
      if (next - 1 >= 0 && jumpToEntry(entries[next - 1])) navCursor = next - 1;
      else { navCursor = -1; scrollChatToBottom(); }
    }
  }

  const TURN_EPS = 100;

  function userTurnEls() {
    for (const s of SEL.USER_MESSAGE) {
      try {
        const els = document.querySelectorAll(s);
        if (els.length) return Array.from(els);
      } catch { /* skip invalid selector */ }
    }
    return [];
  }

  function turnStep(dir) {
    const els = userTurnEls();
    if (!els.length) { bumpNav(); return; }
    if (dir < 0) {
      for (let i = els.length - 1; i >= 0; i--) {
        if (els[i].getBoundingClientRect().top < -TURN_EPS) {
          els[i].scrollIntoView({ behavior: 'smooth', block: 'start' });
          return;
        }
      }
      bumpNav();
    } else {
      for (let i = 0; i < els.length; i++) {
        if (els[i].getBoundingClientRect().top > TURN_EPS) {
          els[i].scrollIntoView({ behavior: 'smooth', block: 'start' });
          return;
        }
      }
      scrollChatToBottom();
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // CREATE BOOKMARK
  // ────────────────────────────────────────────────────────────────────

  function createBookmark(selection, type = 'bookmark') {
    const title = selection.text.length > TITLE_LENGTH
      ? selection.text.slice(0, TITLE_LENGTH).trimEnd() + '…'
      : selection.text;

    bookmarks.unshift({
      id: nextId++,
      title,
      type,
      searchText: selection.text,
    });
    while (bookmarks.length > MAX_BOOKMARKS) bookmarks.pop();
    navCursor = -1;
    renderSidebar();
  }

  // ────────────────────────────────────────────────────────────────────
  // SIDEBAR UI
  // ────────────────────────────────────────────────────────────────────

  let sidebarRoot = null;
  let collapsed = true;

  function ensureSidebar() {
    if (sidebarRoot && document.body.contains(sidebarRoot)) return;
    sidebarRoot = document.createElement('div');
    sidebarRoot.id = 'crpb-sidebar';
    sidebarRoot.innerHTML = `
      <div class="crpb-header">
        <span class="crpb-title">${SITE === 'claude' ? 'Reply tags' : 'Bookmarks'}</span>
        <button class="crpb-sidecar-toggle" aria-label="Toggle sidecar receiver" title="Sidecar: receive lookups from other tabs">⊕</button>
        <button class="crpb-clear-btn" aria-label="Clear all bookmarks" title="Clear all">×</button>
        <button class="crpb-toggle" aria-label="Collapse"></button>
      </div>
      <div class="crpb-nav" role="group" aria-label="Navigate bookmarks and turns">
        <button class="crpb-nav-btn crpb-nav-bm" data-nav="bm-up" aria-label="Older bookmark/reply" title="Older bookmark/reply">▲</button>
        <button class="crpb-nav-btn crpb-nav-bm" data-nav="bm-down" aria-label="Newer bookmark/reply" title="Newer bookmark/reply — past newest: chat bottom">▼</button>
        <span class="crpb-nav-sep" aria-hidden="true"></span>
        <button class="crpb-nav-btn crpb-nav-turn" data-nav="turn-up" aria-label="Previous turn" title="Previous turn">↑</button>
        <button class="crpb-nav-btn crpb-nav-turn" data-nav="turn-down" aria-label="Next turn" title="Next turn — past last: chat bottom">↓</button>
      </div>
      <ul class="crpb-list" role="list"></ul>
      <div class="crpb-empty">No bookmarks yet. Select text in a response to bookmark your place.</div>
    `;
    sidebarRoot.classList.toggle('crpb-collapsed', collapsed);
    document.body.appendChild(sidebarRoot);

    const sidecarToggle = sidebarRoot.querySelector('.crpb-sidecar-toggle');
    chrome.runtime.sendMessage({ action: 'sidecar-status' }, (resp) => {
      if (resp && resp.isReceiver) {
        sidecarToggle.classList.add('crpb-sidecar-active');
        isReceiver = true;
      }
    });
    sidecarToggle.addEventListener('click', () => {
      const active = sidecarToggle.classList.toggle('crpb-sidecar-active');
      isReceiver = active;
      chrome.runtime.sendMessage({
        action: active ? 'sidecar-register' : 'sidecar-unregister',
      });
    });

    sidebarRoot.querySelector('.crpb-toggle').addEventListener('click', () => {
      collapsed = !collapsed;
      sidebarRoot.classList.toggle('crpb-collapsed', collapsed);
    });

    const NAV_ACTIONS = {
      'bm-up': navOlder,
      'bm-down': navNewer,
      'turn-up': () => turnStep(-1),
      'turn-down': () => turnStep(1),
    };
    sidebarRoot.querySelectorAll('.crpb-nav-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        NAV_ACTIONS[btn.dataset.nav]();
      });
    });

    sidebarRoot.querySelector('.crpb-clear-btn').addEventListener('click', () => {
      bookmarks.length = 0;
      restoredBookmarks.length = 0;
      navCursor = -1;
      chrome.storage.local.remove('bookmarks:' + window.location.href);
      renderSidebar();
    });
  }

  function renderSidebar() {
    ensureSidebar();
    const list = sidebarRoot.querySelector('.crpb-list');
    const empty = sidebarRoot.querySelector('.crpb-empty');
    list.innerHTML = '';

    const allEmpty = bookmarks.length === 0 && restoredBookmarks.length === 0;
    if (allEmpty) {
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    for (const bm of bookmarks) {
      const li = document.createElement('li');
      li.className = 'crpb-item';

      const titleBtn = document.createElement('button');
      titleBtn.className = 'crpb-title-btn';
      const iconSpan = document.createElement('span');
      iconSpan.className = 'crpb-bm-icon ' + (bm.type === 'reply' ? 'crpb-bm-icon-reply' : 'crpb-bm-icon-mark');
      iconSpan.textContent = bm.type === 'reply' ? '↩' : '◈';
      titleBtn.appendChild(iconSpan);
      titleBtn.appendChild(document.createTextNode(bm.title));
      titleBtn.title = 'Jump to where you were reading';
      titleBtn.addEventListener('click', () => {
        seatCursor('live', bm);
        if (!jumpToA(bm)) showSidecarFeedback('Not found on page');
      });

      const removeBtn = document.createElement('button');
      removeBtn.className = 'crpb-remove-btn';
      removeBtn.setAttribute('aria-label', 'Remove bookmark');
      removeBtn.title = 'Remove';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => {
        const idx = bookmarks.indexOf(bm);
        if (idx !== -1) bookmarks.splice(idx, 1);
        navCursor = -1;
        renderSidebar();
      });

      li.appendChild(titleBtn);
      if (SITE === 'claude') {
        const bBtn = document.createElement('button');
        bBtn.className = 'crpb-b-btn';
        bBtn.setAttribute('aria-label', 'Jump to end of this assistant response');
        bBtn.title = 'Jump to end of this assistant response';
        bBtn.textContent = '↓';
        bBtn.addEventListener('click', () => jumpToB(bm));
        li.appendChild(bBtn);
      }
      li.appendChild(removeBtn);
      list.appendChild(li);
    }

    for (const entry of restoredBookmarks) {
      const li = document.createElement('li');
      li.className = 'crpb-item crpb-item-restored';

      const titleBtn = document.createElement('button');
      titleBtn.className = 'crpb-title-btn';
      const iconSpan = document.createElement('span');
      iconSpan.className = 'crpb-bm-icon ' + (entry.label === 'reply' ? 'crpb-bm-icon-reply' : 'crpb-bm-icon-mark');
      iconSpan.textContent = entry.label === 'reply' ? '↩' : '◈';
      titleBtn.appendChild(iconSpan);
      const titleText = entry.text.length > 60 ? entry.text.slice(0, 60).trimEnd() + '…' : entry.text;
      titleBtn.appendChild(document.createTextNode(titleText));
      titleBtn.title = 'Restored — click to find in page';
      titleBtn.addEventListener('click', () => {
        seatCursor('restored', entry);
        const found = jumpToRestored(entry);
        if (!found) {
          titleBtn.textContent = 'Not found';
          setTimeout(() => {
            titleBtn.textContent = '';
            titleBtn.appendChild(iconSpan);
            titleBtn.appendChild(document.createTextNode(titleText));
          }, 2000);
        }
      });

      const removeBtn = document.createElement('button');
      removeBtn.className = 'crpb-remove-btn';
      removeBtn.setAttribute('aria-label', 'Remove bookmark');
      removeBtn.title = 'Remove';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => {
        const idx = restoredBookmarks.indexOf(entry);
        if (idx !== -1) restoredBookmarks.splice(idx, 1);
        navCursor = -1;
        renderSidebar();
      });

      li.appendChild(titleBtn);
      li.appendChild(removeBtn);
      list.appendChild(li);
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // JUMP + FLASH
  // ────────────────────────────────────────────────────────────────────

  function findTextRange(needle) {
    const target = needle.replace(/\s+/g, '');
    if (!target) return null;

    const map = [];
    let hay = '';
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (sidebarRoot && sidebarRoot.contains(node)) continue;
      const s = node.nodeValue;
      for (let i = 0; i < s.length; i++) {
        if (/\s/.test(s[i])) continue;
        hay += s[i];
        map.push({ node, off: i });
      }
    }

    const candidates = target.length > 80 ? [target, target.slice(0, 80)] : [target];
    for (const t of candidates) {
      const idx = hay.indexOf(t);
      if (idx === -1) continue;
      const a = map[idx];
      const b = map[idx + t.length - 1];
      const range = document.createRange();
      range.setStart(a.node, a.off);
      range.setEnd(b.node, b.off + 1);
      return range;
    }
    return null;
  }

  function jumpToText(searchText) {
    const range = findTextRange(searchText);
    if (!range) return false;
    range.startContainer.parentElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Restore the actual selection rather than a timed decoration
    // (Tod + Tab, 2026-08-07): a real selection uses the browser's own
    // native highlight, which persists until you click elsewhere instead
    // of fading on a timer -- and it means the composer macro buttons
    // (which read window.getSelection()) can act on a bookmark directly,
    // no separate "explain this bookmark" affordance needed.
    setTimeout(() => {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }, 300);
    return true;
  }

  function jumpToA(bm) { return jumpToText(bm.searchText); }
  function jumpToRestored(entry) { return jumpToText(entry.text); }

  function jumpToB(bm) {
    const range = findTextRange(bm.searchText);
    if (!range) return;
    const turn = closestMatching(range.startContainer, SEL.ASSISTANT_TURN);
    (turn || range.startContainer.parentElement)
      .scrollIntoView({ behavior: 'smooth', block: 'end' });
  }

  // ────────────────────────────────────────────────────────────────────
  // COMPOSER MACRO BUTTONS (Claude only) — one-click reply macros above
  // the input box. Ported from ai-chat-capture's content.js (2026-08-06/07
  // work), reconciled onto this file's own findInput()/appendReply()
  // instead of duplicating a second composer-finder.
  // ────────────────────────────────────────────────────────────────────

  // Two different objects, same five buttons: with no selection, the left
  // group (Explain/Clarify/Elaborate) acts on what you're about to type
  // and the right group (Expand/Condense) acts on Claude's last reply --
  // with a live selection, ALL FIVE act on that selection instead (Tod +
  // Tab, 2026-08-07). Tooltips carry the actual rule; the divider between
  // the groups is shorthand for it, not the full explanation.
  const INTENT_VERBS = [
    { label: 'Explain', title: 'Explain your selection, or what you\'re about to type' },
    { label: 'Clarify', title: 'Clarify your selection, or what you\'re about to type' },
    { label: 'Elaborate', title: 'Elaborate on your selection, or what you\'re about to type' },
  ];
  const RESPONSE_ACTIONS = [
    { label: 'Expand', text: 'Please give a more elaborate version of your previous response.',
      selectionText: 'Please give a more elaborate version of this passage:',
      title: 'Expand your selection, or my previous response' },
    { label: 'Condense', text: 'Please condense your previous response.',
      selectionText: 'Please condense this passage:',
      title: 'Condense your selection, or my previous response' },
  ];
  const VERBOSITY_LEVELS = [
    { key: 'very-terse', label: 'Very terse' },
    { key: 'terse', label: 'Terse' },
    { key: 'normal', label: 'Normal' },
    { key: 'verbose', label: 'Verbose' },
  ];
  // The verbosity stamp is a bracket token (;;verbosity:LEVEL;;), not
  // prose, deliberately: it's greppable/machine-readable in whatever log
  // you keep of your own conversations, and — unlike a plain-English
  // sentence — a model reliably reads it as metadata about the message
  // rather than as part of the request itself.
  const VERBOSITY_DIRECTIVES = {
    'very-terse': 'Use as few words as you possibly can in your response.',
    'terse': 'Use fewer words than you normally would in your response.',
    'normal': 'Respond at your normal length -- no length constraint.',
    'verbose': 'Provide a more detailed, thorough response than you normally would.',
  };

  let _claudeSendScheduled = false;

  function _doClaudeSend() {
    setTimeout(() => {
      _claudeSendScheduled = false;
      let attempts = 0;
      function trySend() {
        const sendBtn = findSubmit();
        if (sendBtn && !sendBtn.disabled) {
          setTimeout(() => {
            const confirmBtn = findSubmit();
            if (confirmBtn && !confirmBtn.disabled) {
              confirmBtn.click();
            } else {
              attempts++;
              setTimeout(trySend, 150);
            }
          }, 1500);
        } else {
          attempts++;
          if (attempts >= 8000) {
            console.warn('[CCT] Send button never became clickable in 20min — giving up');
            _claudeSendScheduled = false;
            return;
          }
          setTimeout(trySend, 150);
        }
      }
      trySend();
    }, 800);
  }

  function _insertAtCursorEdge(text, atStart) {
    const editor = findInput();
    if (!editor) return;
    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(atStart);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('insertText', false, text);
  }

  function _selectedQuote() {
    const text = (window.getSelection()?.toString() || '').trim();
    if (!text) return null;
    return '> ' + text.replace(/\n/g, '\n> ') + '\n\n';
  }

  let levelBtns = [];
  let currentConvId = null;
  let currentLevel = null;
  const _stampedThisConv = new Set();

  function _convId() {
    const m = location.pathname.match(/\/chat\/([0-9a-f-]+)/i);
    return m ? m[1] : null;
  }
  function _keyLevel(id) { return `cctVerbosityLevel:${id}`; }
  function _keyStamped(id) { return `cctVerbosityStamped:${id}`; }

  function _setActiveLevelButton(level) {
    levelBtns.forEach(b => {
      const active = b.dataset.level === level;
      b.style.background = active ? '#89b4fa' : '#2a2a3e';
      b.style.color = active ? '#1e1e2e' : '#aaa';
    });
  }

  async function _resolveVerbosityForConv() {
    const convId = _convId();
    if (convId === currentConvId) return;
    currentConvId = convId;
    currentLevel = null;
    _setActiveLevelButton(null);
    if (!convId) return;
    const result = await chrome.storage.local.get(_keyLevel(convId));
    const level = result[_keyLevel(convId)];
    if (level) {
      currentLevel = level;
      _setActiveLevelButton(level);
    }
  }

  function _stampForSend() {
    if (!currentLevel || !currentConvId) return;
    const marker = `;;verbosity:${currentLevel};;`;
    if (!_stampedThisConv.has(currentConvId)) {
      _stampedThisConv.add(currentConvId);
      chrome.storage.local.set({ [_keyStamped(currentConvId)]: true }).catch(() => {});
      _insertAtCursorEdge(' ' + VERBOSITY_DIRECTIVES[currentLevel] + ' ' + marker, false);
    } else {
      _insertAtCursorEdge(' ' + marker, false);
    }
  }

  let _stampingGuard = false;
  function _guardedStamp() {
    if (_stampingGuard) return;
    _stampingGuard = true;
    _stampForSend();
    setTimeout(() => { _stampingGuard = false; }, 300);
  }
  document.addEventListener('keydown', (e) => {
    if (SITE !== 'claude') return;
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey) return;
    const editor = findInput();
    if (!editor || !editor.contains(e.target)) return;
    _guardedStamp();
  }, true);
  document.addEventListener('click', (e) => {
    if (SITE !== 'claude') return;
    const sendBtn = findSubmit();
    if (!sendBtn || !sendBtn.contains(e.target)) return;
    _guardedStamp();
  }, true);

  function _makeMacroBtn(label, title) {
    const b = document.createElement('button');
    b.textContent = label;
    if (title) b.title = title;
    b.style.cssText = [
      'padding:3px 10px', 'background:#2a2a3e', 'color:#aaa',
      'border:1px solid #555', 'border-radius:6px', 'cursor:pointer',
      'font-size:11px',
    ].join(';');
    return b;
  }

  function _makeGroupDivider() {
    const d = document.createElement('span');
    d.textContent = '|';
    d.style.cssText = 'color:#444;margin:0 2px';
    return d;
  }

  function _buildMacroRow() {
    const container = document.createElement('div');
    container.id = 'cct-macro-buttons';
    container.style.cssText = [
      'display:flex', 'gap:6px', 'flex-wrap:wrap', 'align-items:center',
      'padding:4px 2px', 'font-family:system-ui,sans-serif', 'font-size:11px',
    ].join(';');

    INTENT_VERBS.forEach(({ label: verb, title }) => {
      const b = _makeMacroBtn(verb, title);
      b.addEventListener('click', () => {
        const quote = _selectedQuote();
        if (quote) {
          _insertAtCursorEdge(verb + ' the quoted passage:\n\n' + quote, true);
          if (!_claudeSendScheduled) { _claudeSendScheduled = true; _doClaudeSend(); }
          return;
        }
        const existing = findInput()?.textContent || '';
        const wasEmpty = !existing.trim();
        const label = existing.trim().startsWith('>')
          ? verb + ' the quoted passage: '
          : verb + ': ';
        _insertAtCursorEdge(label, true);
        if (wasEmpty) return;
        if (!_claudeSendScheduled) { _claudeSendScheduled = true; _doClaudeSend(); }
      });
      container.appendChild(b);
    });

    // Group divider: left group acts on typed text by default, right group
    // acts on Claude's last reply by default — see the tooltip comment above.
    container.appendChild(_makeGroupDivider());

    RESPONSE_ACTIONS.forEach(({ label, text, selectionText, title }) => {
      const b = _makeMacroBtn(label, title);
      b.addEventListener('click', () => {
        const quote = _selectedQuote();
        const directive = quote ? selectionText + '\n\n' + quote : text + ' ';
        _insertAtCursorEdge(directive, true);
        if (!_claudeSendScheduled) { _claudeSendScheduled = true; _doClaudeSend(); }
      });
      container.appendChild(b);
    });

    const sep = document.createElement('span');
    sep.textContent = '|';
    sep.style.cssText = 'color:#444;margin:0 2px';
    container.appendChild(sep);

    VERBOSITY_LEVELS.forEach(({ key, label }) => {
      const b = _makeMacroBtn(label);
      b.dataset.level = key;
      b.addEventListener('click', async () => {
        const convId = _convId();
        if (!convId) return;
        currentConvId = convId;
        currentLevel = key;
        _stampedThisConv.delete(convId);
        await chrome.storage.local.set({ [_keyLevel(convId)]: key }).catch(() => {});
        await chrome.storage.local.remove(_keyStamped(convId)).catch(() => {});
        _setActiveLevelButton(key);
      });
      levelBtns.push(b);
      container.appendChild(b);
    });

    return container;
  }

  function _armMacroRow() {
    if (SITE !== 'claude') return;
    if (document.getElementById('cct-macro-buttons')) return;
    const editor = findInput();
    if (!editor) return;
    const host = editor.closest('[data-testid="chat-input"]') || editor.parentElement;
    if (!host || !host.parentElement) return;
    host.parentElement.insertBefore(_buildMacroRow(), host);
  }

  // ────────────────────────────────────────────────────────────────────
  // BOOT
  // ────────────────────────────────────────────────────────────────────

  function loadRestoredBookmarks(clearLive) {
    if (clearLive) {
      bookmarks.length = 0;
    }
    restoredBookmarks.length = 0;
    navCursor = -1;
    renderSidebar();
    chrome.runtime.sendMessage({ action: 'get-bookmarks', sourceUrl: window.location.href }, (resp) => {
      if (resp && resp.entries && resp.entries.length > 0) {
        for (const e of resp.entries) {
          restoredBookmarks.push(e);
        }
      }
      renderSidebar();
    });
  }

  function extractChatId(url) {
    try {
      const p = new URL(url).pathname;
      const m = SITE === 'claude' ? p.match(/\/chat\/([^/]+)/)
              : SITE === 'gemini' ? p.match(/\/app\/([^/]+)/)
              : SITE === 'chatgpt' ? p.match(/\/c\/([^/]+)/)
              : null;
      return m ? m[1] : null;
    } catch { return null; }
  }

  function boot() {
    ensureSidebar();
    renderSidebar();
    loadRestoredBookmarks();
    if (SITE === 'claude') {
      _resolveVerbosityForConv();
      _armMacroRow();
    }

    let _lastUrl = window.location.href;
    let boundChatId = extractChatId(window.location.href);

    function handleUrlChange() {
      const fromUrl = _lastUrl;
      const newUrl = window.location.href;
      if (newUrl === fromUrl) return;
      _lastUrl = newUrl;
      const newId = extractChatId(newUrl);

      if (SITE === 'claude') {
        _resolveVerbosityForConv();
        _armMacroRow();
      }

      if (newId === null) return;

      if (boundChatId === null) {
        if (bookmarks.length) {
          chrome.runtime.sendMessage({
            action: 'migrate-bookmarks',
            fromUrl,
            toUrl: newUrl,
            entries: [...bookmarks].reverse().map(bm => ({ label: bm.type, text: bm.searchText })),
          });
        } else {
          loadRestoredBookmarks(false);
        }
        boundChatId = newId;
        return;
      }

      if (newId === boundChatId) return;

      boundChatId = newId;
      loadRestoredBookmarks(true);
    }

    setInterval(handleUrlChange, 500);
    window.addEventListener('popstate', handleUrlChange);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
