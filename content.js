// SlipStream
// Two independent pieces sharing one page, both multi-site (Claude, Gemini,
// ChatGPT, Copilot/M365):
//  1. Reply/bookmark sidebar — select text in a response, bookmark your
//     place or quote it into a reply, jump back later.
//  2. Composer macro buttons — one-click reply macros above the composer:
//     Explain/Clarify/Elaborate a selection or your last request, Expand/
//     Condense a selection or the assistant's own last reply, plus a
//     persistent per-conversation verbosity level. Each site's composer
//     quirks are isolated behind SITE_SEL/INPUT_SELECTORS/SUBMIT_STRATEGY
//     rather than branching throughout.
// Everything lives in chrome.storage.local. No account, no server, no
// network calls at all.

(function () {
  'use strict';

  // Tod-ruled 2026-08-08: off everywhere, private build included, until
  // the cross-tab "sidecar" feature (Ask aside / Define send, the "Who's
  // Listening" receiver toggle) is redesigned -- not ready to explain what
  // happens when you interact with other tabs. A single flag here, rather
  // than deleting the feature, keeps it a one-line flip to bring back
  // rather than a re-diff against history.
  const INCLUDE_SIDECAR_ASIDE = false;

  // ────────────────────────────────────────────────────────────────────
  // SITE DETECTION
  // ────────────────────────────────────────────────────────────────────

  const SITE = location.hostname.includes('gemini.google.com') ? 'gemini'
             : (location.hostname.includes('chatgpt.com') || location.hostname.includes('chat.openai.com')) ? 'chatgpt'
             : location.hostname.includes('m365.cloud.microsoft') ? 'copilot'
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
    copilot: {
      ASSISTANT_TURN: ['[data-testid="copilot-message-div"]'],
      USER_MESSAGE: ['[data-testid="chatQuestion"]'],
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

    for (const { label, prefix } of (INCLUDE_SIDECAR_ASIDE ? SIDECAR_PROMPTS : [])) {
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
    '#m365-chat-editor-target-element',
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

  // Copilot-specific paste path (Tab/Tod-directed diagnostic session,
  // 2026-08-08/09): the previous approach -- synthetic mousedown/mouseup/
  // click on the editor, then execCommand('insertText') -- worked when
  // called from an independent script where the editor was already the
  // last thing genuinely focused, but silently no-ops when called from
  // inside the send button's own click handler, where focus is genuinely
  // on the button at that moment. Instrumented live: _ownSend() DOES
  // intercept the click and _confirmStampThenSend() DOES run its full
  // poll loop, but the composer text never changes across any attempt --
  // Lexical doesn't accept synthetic (untrusted) mouse events as a real
  // focus/selection change, so execCommand silently writes nowhere
  // Lexical's own model reconciles. A paste event is a first-class,
  // framework-recognized input path (Lexical implements paste handling
  // directly, same reasoning as chatgptPaste above for ChatGPT's picky
  // editor) and doesn't depend on precisely re-establishing focus first.
  function copilotPaste(input, text, atStart) {
    input.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(!!atStart);
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

    // Outward-only signal, never a dependency (Tod/Tab-ruled 2026-08-07):
    // a plain DOM CustomEvent, the same contract the older
    // claude-navigation-sidebar extension used. ai-chat-capture already
    // listens for this and posts it to ringleader if it happens to be
    // installed alongside this extension -- if it isn't, this is a no-op.
    // Nothing in this toolkit's own behavior may ever come to depend on
    // something being on the other end.
    document.dispatchEvent(new CustomEvent('crpb-bookmark', { detail: { text: selection.text } }));
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
        ${INCLUDE_SIDECAR_ASIDE ? '<button class="crpb-sidecar-toggle" aria-label="Toggle sidecar receiver" title="Sidecar: receive lookups from other tabs">⊕</button>' : ''}
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
    if (sidecarToggle) {
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
    }

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

  // Per-site submit strategy (2026-08-07, Tab-suggested, replacing an
  // earlier timeout-based fallback): confirmed live that ChatGPT's real
  // DOM matches none of SUBMIT_SELECTORS, so a button-first approach paid
  // a fixed ~1.5s latency tax on every single ChatGPT send before ever
  // reaching the keyboard path -- not an edge case there, the ONLY path.
  // Declaring it up front means ChatGPT sends immediately via keyboard,
  // no wasted retries; Claude keeps its button-click-with-retry, which is
  // needed there for the disabled/mid-generation state a keydown can't
  // detect. Unlisted sites default to 'button' -- the safer of the two
  // when a new one's real behavior isn't confirmed yet.
  const SUBMIT_STRATEGY = { chatgpt: 'keyboard' };
  function _submitStrategyFor(site) { return SUBMIT_STRATEGY[site] || 'button'; }

  // Retries the keydown, not fire-once (2026-08-07, Tab-flagged: a single
  // dispatch that doesn't take -- composer not focused, event swallowed --
  // never gets a second chance). BUT found live the same day, in a worse
  // form than predicted: on a site where the synthetic Enter isn't treated
  // as submit, the composer's own JS may insert a literal newline instead
  // -- so retrying blindly for 20 minutes at 600ms doesn't just fail
  // quietly, it appends ~2000 newlines to the composer (observed as the
  // textarea "expanding like mad"). Growing composer length is PROOF the
  // strategy isn't working on this site, not a reason to keep trying --
  // abort immediately on that signal, and cap total attempts hard regardless
  // (a few seconds of retrying covers "event was swallowed once"; it does
  // not need twenty minutes to do that).
  function _keyboardSendLoop(deadline, attempt, lastLength) {
    attempt = attempt || 0;
    const MAX_ATTEMPTS = 5;
    const editor = findInput();
    if (!editor) return;
    const len = editor.textContent.length;
    if (!editor.textContent.trim()) return; // sent, or nothing left to send
    if (lastLength != null && len > lastLength) {
      console.warn('[CCT] Keyboard submit is growing the composer instead of clearing it — aborting (site likely treats Enter as newline, not submit)');
      return;
    }
    if (attempt >= MAX_ATTEMPTS || Date.now() >= deadline) {
      console.warn('[CCT] Keyboard submit never cleared the composer — giving up after', attempt, 'attempts');
      return;
    }
    editor.focus();
    editor.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true,
    }));
    setTimeout(() => _keyboardSendLoop(deadline, attempt + 1, len), 600);
  }

  function _doClaudeSend() {
    setTimeout(() => {
      _claudeSendScheduled = false;
      if (_submitStrategyFor(SITE) === 'keyboard') {
        _keyboardSendLoop(Date.now() + 20 * 60 * 1000);
        return;
      }
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
          return;
        }
        attempts++;
        if (attempts >= 8000) {
          console.warn('[CCT] Send button never became clickable in 20min — giving up');
          _claudeSendScheduled = false;
          return;
        }
        setTimeout(trySend, 150);
      }
      trySend();
    }, 800);
  }

  function _insertAtCursorEdge(text, atStart) {
    const editor = findInput();
    if (!editor) return;
    // Copilot/Lexical: paste event, not synthetic-click-then-execCommand
    // (see copilotPaste's comment for why the old approach silently failed
    // specifically when called from inside the send button's own click
    // handler -- found live 2026-08-09).
    if (SITE === 'copilot') {
      copilotPaste(editor, text, atStart);
      return;
    }
    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(atStart);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('insertText', false, text);
  }

  // Stale-selection hazard (Tod/Tab-ruled 2026-08-07): a browser selection
  // persists until the user clicks elsewhere, so it can silently outlive
  // the moment it was made -- select a paragraph, scroll away, type a new
  // question, hit a macro button, and it quotes the old selection instead
  // of answering what was just typed, with nothing indicating it happened.
  // Visibility rather than recency: ChatGPT's own native selection-reply
  // button already disappears once the selection scrolls off screen, so
  // matching that is a pattern users are already trained on rather than a
  // timer whose threshold would need explaining or tuning.
  function _selectionVisible() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false; // collapsed
    return rect.bottom > 0 && rect.top < window.innerHeight &&
           rect.right > 0 && rect.left < window.innerWidth;
  }

  function _selectedQuote() {
    const text = (window.getSelection()?.toString() || '').trim();
    if (!text) return null;
    if (!_selectionVisible()) return null;
    return '> ' + text.replace(/\n/g, '\n> ') + '\n\n';
  }

  let levelBtns = [];
  // undefined, not null (found live 2026-08-08 via actual browser testing,
  // not just reading the code): _resolveVerbosityForConv()'s dedup guard
  // is `if (convId === currentConvId) return`. A fresh /new page's convId
  // IS null (extractChatId finds no id), so if this started at null too,
  // the very first boot call short-circuited before ever reaching the
  // default-assignment branch -- the row built with no highlight applied,
  // even though the code reasoning said it should default to Normal.
  // undefined can never equal what _convId() returns (null or a string),
  // so the first call always proceeds regardless of what page it lands on.
  let currentConvId = undefined;
  let currentLevel = null;
  const _stampedThisConv = new Set();

  // Multi-site fix (2026-08-07): was Claude-only (/chat/<id>), which meant
  // the verbosity level would key off a null id on Gemini/ChatGPT and
  // silently persist to the wrong place, or nowhere. extractChatId already
  // handles all three site URL shapes -- reuse it instead of duplicating.
  function _convId() {
    return extractChatId(location.href);
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

  // Tod-ruled 2026-08-08: default to Normal rather than no level active.
  // Previously a fresh conversation had no level set at all, so nothing
  // got stamped until you explicitly picked one -- now every conversation
  // starts with an explicit (if unremarkable) choice, consistent from the
  // first message rather than only once you've touched a button.
  const DEFAULT_VERBOSITY_LEVEL = 'normal';

  async function _resolveVerbosityForConv() {
    const convId = _convId();
    if (convId === currentConvId) return;
    currentConvId = convId;
    if (!convId) {
      // Fresh "new chat" page -- no conversation id in the URL yet (found
      // live 2026-08-08: Tod's very first message on a brand-new chat sent
      // unstamped and unhighlighted, because the old code bailed here
      // before ever applying the default). Nothing to persist to until a
      // real conv id exists, but the row should still show the default
      // rather than looking unset. _ownSend() still requires currentConvId
      // truthy to stamp, so this message remains unstamped regardless --
      // that first-message gap closes itself once the site assigns a real
      // id and this function re-runs, known and separate from the paint.
      currentLevel = DEFAULT_VERBOSITY_LEVEL;
      _setActiveLevelButton(DEFAULT_VERBOSITY_LEVEL);
      return;
    }
    currentLevel = null;
    _setActiveLevelButton(null);
    const result = await chrome.storage.local.get(_keyLevel(convId));
    const level = result[_keyLevel(convId)] || DEFAULT_VERBOSITY_LEVEL;
    currentLevel = level;
    _setActiveLevelButton(level);
  }

  // Tab-caught 2026-08-08: currentConvId gated *emitting* the stamp, but it's
  // only needed to *persist* one -- currentLevel is what the marker needs,
  // and that's now defaulted to Normal even pre-conversation. Requiring
  // convId here meant the very first message of any brand-new chat (no
  // conv id yet, since the site assigns one only once that message creates
  // it) always went out unstamped. Persistence still needs a real id, so
  // that part stays gated; a null-convId send just skips the storage write
  // and _stampedThisConv bookkeeping, which costs at most one redundant
  // repeat of the full directive on the second message once the real id
  // exists and this state resets -- cheap compared to the first message
  // silently carrying no marker at all.
  function _stampForSend() {
    if (!currentLevel) return;
    const marker = `;;verbosity:${currentLevel};;`;
    if (!currentConvId || !_stampedThisConv.has(currentConvId)) {
      if (currentConvId) {
        _stampedThisConv.add(currentConvId);
        chrome.storage.local.set({ [_keyStamped(currentConvId)]: true }).catch(() => {});
      }
      _insertAtCursorEdge(' ' + VERBOSITY_DIRECTIVES[currentLevel] + ' ' + marker, false);
    } else {
      _insertAtCursorEdge(' ' + marker, false);
    }
  }

  // Own-the-send (Tod/Tab-ruled 2026-08-08, replacing the old write-and-hope
  // _guardedStamp): the previous version wrote the stamp during the event's
  // capturing phase and trusted the site's own send handler, firing a beat
  // later on the same event, to pick it up -- a write-then-read race, same
  // shape as the earlier ChatGPT type=submit bug. The macro buttons never
  // had this problem because they own the send outright: insert, then
  // invoke the send path themselves. This makes manual sends do the same --
  // intercept the real send trigger, stamp, confirm the composer reflects
  // it (bounded retries, not a blind delay), then trigger the send via
  // _doClaudeSend(), the exact path the buttons already prove reaches all
  // four sites. If the stamp never confirms, send anyway -- Tab's point:
  // a message that goes out unstamped is recoverable, one that never goes
  // out because we swallowed the user's Enter/click is not.
  //
  // Reentrancy: _doClaudeSend() ends up generating its own synthetic click
  // (button-strategy sites) or synthetic keydown Enter (keyboard-strategy,
  // _keyboardSendLoop) to actually trigger the site's send. Those re-enter
  // these same capturing listeners. Event.isTrusted distinguishes a real
  // user action from a script-dispatched one natively, so synthetic events
  // fall through unowned rather than needing a hand-rolled guard flag.
  let _ownSendInFlight = false;
  const STAMP_CONFIRM_ATTEMPTS = 10;
  const STAMP_CONFIRM_INTERVAL_MS = 30;

  function _composerHasMarker(marker) {
    const editor = findInput();
    const text = editor ? editor.textContent : '';
    return text.trimEnd().endsWith(marker);
  }

  // Strips a trailing verbosity stamp (with or without its directive
  // sentence) so a stranded marker left over from a prior send attempt
  // doesn't count as user-typed content. Built from all known levels/
  // directives, not just currentLevel, since the stray text could predate
  // a level change.
  function _strippedOfMarker(text) {
    const levels = VERBOSITY_LEVELS.map(l => l.key).join('|');
    const directives = Object.values(VERBOSITY_DIRECTIVES)
      .map(d => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const re = new RegExp('(?:\\s*(?:' + directives + '))?\\s*;;verbosity:(?:' + levels + ');;\\s*$');
    return text.replace(re, '').trim();
  }

  // Single source of truth for "is there anything the user actually typed"
  // -- shared by _ownSend's send-interception guard and the macro buttons'
  // wasEmpty check below, which used to be two separate guards (`!text.trim()`
  // in the buttons, none at all in _ownSend) that could drift out of sync.
  function _isEmptyOfUserContent(text) {
    if (text == null) {
      const editor = findInput();
      text = editor ? editor.textContent : '';
    }
    return _strippedOfMarker(text).length === 0;
  }

  function _triggerRealSend() {
    if (!_claudeSendScheduled) { _claudeSendScheduled = true; _doClaudeSend(); }
  }

  function _confirmStampThenSend(attempt) {
    attempt = attempt || 0;
    const marker = `;;verbosity:${currentLevel};;`;
    if (_composerHasMarker(marker)) {
      _ownSendInFlight = false;
      _triggerRealSend();
      return;
    }
    if (attempt === 0) _stampForSend();
    if (attempt >= STAMP_CONFIRM_ATTEMPTS) {
      console.warn('[CCT] Verbosity stamp did not land within', STAMP_CONFIRM_ATTEMPTS * STAMP_CONFIRM_INTERVAL_MS, 'ms -- sending unstamped rather than blocking the message');
      _ownSendInFlight = false;
      _triggerRealSend();
      return;
    }
    setTimeout(() => _confirmStampThenSend(attempt + 1), STAMP_CONFIRM_INTERVAL_MS);
  }

  function _ownSend(e) {
    if (_ownSendInFlight) return;
    // Empty-composer guard (2026-08-10, hit twice live): without this, an
    // Enter/click on an empty composer still fell through to the stamp step
    // below, which WROTE the marker -- turning what should have been a
    // native no-op into a real send whose entire body was the bare stamp.
    // Must run before preventDefault/stopImmediatePropagation: after those,
    // the native path they were meant to suppress-and-replace is gone, so
    // there'd be nothing left to fall back to.
    if (_isEmptyOfUserContent()) return;
    // currentConvId not required here -- see _stampForSend's comment. A
    // brand-new chat has currentLevel (defaulted) but no convId yet, and
    // that's exactly the message this used to let through unstamped.
    if (!currentLevel) return; // nothing to stamp -- let native send proceed
    _ownSendInFlight = true;
    e.preventDefault();
    e.stopImmediatePropagation();
    // Deferred one tick (Copilot diagnostic session 2026-08-08/09): both
    // execCommand('insertText') and a paste event silently no-op when
    // called synchronously inside this click's own handler -- the button
    // still genuinely has DOM focus at that instant, and neither approach
    // can wrest Lexical's internal selection/focus model away from it
    // mid-dispatch. preventDefault/stopImmediatePropagation still apply
    // synchronously (that's the part that must happen inline to block the
    // native submit), but the actual write is pushed to the next tick so
    // the browser finishes its own click bookkeeping first.
    setTimeout(() => _confirmStampThenSend(), 0);
  }

  // Multi-site (2026-08-07): was Claude-only. findInput/findSubmit are
  // already per-site adapters (see RECEIVER section above), so nothing
  // else here is Claude-specific.
  //
  // window, not document: harmless either way in the end (the Copilot bug
  // turned out to be the deferred-write issue above, not listener
  // ordering -- a red herring from reading extension-isolated-world state
  // via a plain page-context CDP call during diagnosis), but window is at
  // least as safe as document for capturing-phase interception, so left
  // as-is rather than reverting.
  window.addEventListener('keydown', (e) => {
    if (!e.isTrusted) return; // our own synthetic Enter from _keyboardSendLoop
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey) return;
    const editor = findInput();
    if (!editor || !editor.contains(e.target)) return;
    _ownSend(e);
  }, true);
  window.addEventListener('click', (e) => {
    if (!e.isTrusted) return; // our own synthetic click from _doClaudeSend's trySend()
    const sendBtn = findSubmit();
    if (!sendBtn || !sendBtn.contains(e.target)) return;
    _ownSend(e);
  }, true);

  function _makeMacroBtn(label, title) {
    const b = document.createElement('button');
    // Found live 2026-08-07, real root cause of the ChatGPT label-drop bug:
    // an unset <button> defaults to type="submit", and the row now lives
    // inside the composer's <form> (needed to anchor above it). Clicking it
    // was firing the browser's OWN native form submit *in addition to* our
    // click handler, and ChatGPT's real submit handler won that race,
    // sending its own pre-insertion state before our execCommand mutation
    // was recognized. type="button" removes that second, uncontrolled
    // trigger entirely -- our explicit send logic becomes the only path.
    b.type = 'button';
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
    // Gemini's composer measures narrower than Claude/ChatGPT's (660px vs
    // 768px), which wrapped the row to two lines -- Tod, 2026-08-07: prefers
    // it stay on one line, expanding a bit past the composer's own width
    // into the page's side margins rather than wrapping, plus tighter
    // spacing as extra headroom.
    const isGemini = SITE === 'gemini';
    container.style.cssText = [
      'display:flex', 'gap:' + (isGemini ? '4px' : '6px'), 'flex-wrap:wrap', 'align-items:center',
      'justify-content:center',
      isGemini ? 'width:calc(100% + 80px)' : '',
      isGemini ? 'margin-left:-40px' : '',
      isGemini ? 'margin-right:-40px' : '',
      'padding:4px 2px', 'font-family:system-ui,sans-serif', 'font-size:11px',
    ].filter(Boolean).join(';');

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
        const wasEmpty = _isEmptyOfUserContent(existing);
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

  // Inline sibling, sized to the composer's own column (Tod-ruled
  // 2026-08-07, superseding an earlier fixed-position/full-viewport-width
  // attempt): that version measured 1280px wide on ChatGPT and looked like
  // a screen-wide black bar, and on a live tab it visibly drifted away from
  // the composer -- floating fixed-position elements need constant
  // repositioning to track their anchor, and any lag between an edit and
  // the next recompute shows up as visible drift. A sibling insertion has
  // no such lag: the browser's own layout keeps it glued to its neighbor
  // for free, and it naturally inherits that neighbor's width instead of
  // the viewport's.
  //
  // `host` is the element to insert the row directly above. Found live
  // 2026-08-07: [data-testid="chat-input"] is on Claude's editable div
  // itself, not a wrapper around it, so anchoring there landed the row a
  // few levels inside the visible white card (next to the textarea, but
  // still inside the box) -- worked as "above the textarea", not what Tod
  // meant by "above the box". Climbing from the editor to the nearest
  // ancestor that actually LOOKS like the box (has its own background and
  // rounded corners) targets what a human points at when they say "the
  // box", regardless of where a testid happens to be attached.
  function _visualCardHost(editor) {
    // Climb to document.body rather than an arbitrary depth cap -- found
    // live 2026-08-07: a fixed cap of 8 missed Gemini's card by one level,
    // and there's no principled number to pick instead. The real bound is
    // "stop before leaving the composer's own DOM neighborhood", not a
    // count of hops.
    let cur = editor;
    while (cur && cur !== document.body) {
      const cs = getComputedStyle(cur);
      const hasBg = cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent';
      const hasRadius = parseFloat(cs.borderRadius) > 0;
      if (hasBg && hasRadius) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  function _composerHost(editor) {
    return _visualCardHost(editor) || editor.closest('form') || editor.parentElement;
  }

  function _armMacroRow() {
    if (document.getElementById('cct-macro-buttons')) return;
    const editor = findInput();
    if (!editor) return;
    const host = _composerHost(editor);
    if (!host || !host.parentElement) return;
    const row = _buildMacroRow();
    host.parentElement.insertBefore(row, host);
    // _buildMacroRow() just populated levelBtns fresh -- reflect whatever
    // level is already known (found live 2026-08-08: _resolveVerbosityForConv()
    // runs before this on cold load, so its _setActiveLevelButton() call landed
    // on an empty levelBtns array and silently no-op'd; the default-to-Normal
    // state was correct internally but never painted). Safe to call even
    // before the async resolve settles -- it'll just repaint once currentLevel
    // updates.
    _setActiveLevelButton(currentLevel);
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
              : SITE === 'copilot' ? p.match(/\/chat\/conversation\/([^/]+)/)
              : null;
      return m ? m[1] : null;
    } catch { return null; }
  }

  // Re-inserts the sidebar/macro row if the host page's own JS removes
  // them (found live 2026-08-07 on ChatGPT: a foreign body-level node
  // gets wiped a second or two after injection, correlated with a React
  // hydration-mismatch error the page throws on load -- exact mechanism
  // unconfirmed, but this fixes it regardless of cause). ensureSidebar and
  // _armMacroRow are both already idempotent (check for existing DOM
  // presence before creating), so re-calling them on removal is safe and
  // does not double-create.
  // Bounded by elapsed time with backoff, not a fixed attempt count
  // (Tab-reviewed 2026-08-08, replacing an earlier 5-attempt cap found
  // live 2026-08-07): a fixed count is being tested against a variable
  // condition -- a cold extension load takes longer to settle than a warm
  // one, and 5 rapid-fire attempts could exhaust themselves before a slow
  // page ever stabilizes, leaving the row permanently blank on exactly the
  // loads that needed the most patience. Backoff (never retry more than
  // once per interval) is what actually prevents the runaway-mutation
  // spin the old cap was guarding against; the count was incidental.
  let _zeroSizeRecoveryFirstSeenAt = null;
  let _zeroSizeRecoveryPending = false;
  let _zeroSizeRecoveryGaveUp = false;
  const ZERO_SIZE_RECOVERY_WINDOW_MS = 20000;
  const ZERO_SIZE_RECOVERY_BACKOFF_MS = 500;

  function _watchForForeignRemoval() {
    const observer = new MutationObserver(() => {
      if (!sidebarRoot || !document.body.contains(sidebarRoot)) {
        ensureSidebar();
        renderSidebar();
      }
      // No SITE gate: _armMacroRow is multi-site now (2026-08-07), and it
      // already no-ops safely if findInput() can't locate a composer.
      const macroRow = document.getElementById('cct-macro-buttons');
      if (!macroRow) {
        _armMacroRow();
      } else if (macroRow.getBoundingClientRect().width === 0) {
        // Found live on claude.ai/new (2026-08-07): the row can survive
        // in the DOM (still attached, still passes the check above) but
        // collapse to zero size, because it was anchored during an early,
        // pre-hydration render and the page later swapped in the real
        // composer around it rather than removing it outright. A missing
        // node and a zero-size node are the same failure from the user's
        // perspective -- reinsert against whatever the DOM looks like now.
        //
        // remove() and _armMacroRow() are themselves DOM mutations, which
        // can refire this exact observer -- if the page never settles into
        // a state _visualCardHost is happy with, this would otherwise
        // retry forever and peg the tab. Backoff (skip re-attempting while
        // one is already scheduled) is what actually bounds that, not the
        // elapsed-time window below -- the window just decides when to
        // stop trying altogether.
        if (_zeroSizeRecoveryFirstSeenAt === null) _zeroSizeRecoveryFirstSeenAt = Date.now();
        const elapsed = Date.now() - _zeroSizeRecoveryFirstSeenAt;
        if (elapsed >= ZERO_SIZE_RECOVERY_WINDOW_MS) {
          if (!_zeroSizeRecoveryGaveUp) {
            _zeroSizeRecoveryGaveUp = true;
            console.warn('[CCT] Macro row stuck at zero size for', Math.round(elapsed / 1000) + 's', '-- giving up, buttons will not appear on this page load');
          }
        } else if (!_zeroSizeRecoveryPending) {
          _zeroSizeRecoveryPending = true;
          setTimeout(() => {
            _zeroSizeRecoveryPending = false;
            const current = document.getElementById('cct-macro-buttons');
            if (current) current.remove();
            _armMacroRow();
          }, ZERO_SIZE_RECOVERY_BACKOFF_MS);
        }
      }
    });
    // Observing documentElement with subtree:true, not just document.body
    // with childList:true (Tab-reviewed 2026-08-07): if the removal
    // mechanism turns out to be a body-level reset rather than a scoped
    // reconciliation, an observer attached to body itself could be
    // orphaned along with the node it's watching. <html> is never
    // replaced by page content, so this survives that case too.
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function boot() {
    ensureSidebar();
    renderSidebar();
    loadRestoredBookmarks();
    // Multi-site (2026-08-07): was Claude-only.
    _resolveVerbosityForConv();
    _armMacroRow();
    _watchForForeignRemoval();

    let _lastUrl = window.location.href;
    let boundChatId = extractChatId(window.location.href);

    function handleUrlChange() {
      const fromUrl = _lastUrl;
      const newUrl = window.location.href;
      if (newUrl === fromUrl) return;
      _lastUrl = newUrl;
      const newId = extractChatId(newUrl);

      _resolveVerbosityForConv();
      _armMacroRow();

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
