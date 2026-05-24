const state = {
  chatPanel: null,
  chatMessages: null,
  chatInput: null,
  sendButton: null,
  headerControls: null,
  popoutButton: null,
  observer: null,
  popoutOpen: false,
  popoutHostPort: null,
  popoutSyncObserver: null,
  popoutSyncTimer: null,
  popoutSyncInterval: null,
  popoutControlsObserver: null,
  popoutControlsTimer: null,
  popoutSession: 0,
  popoutSyncSeq: 0,
  popoutDisconnectTimer: null,
  globalPopoutWatcher: null,
  initialized: false,
};

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      resolve(response ?? { ok: false, error: chrome.runtime.lastError?.message });
    });
  });
}

const hostChat = ReYohohoChat.createController({
  sendRuntimeMessage: sendMessage,
  onActivity: () => pushPopoutSync(),
});

function bindHostChat() {
  if (!state.chatInput || !state.chatMessages) {
    return;
  }

  hostChat.bind({
    chatInput: state.chatInput,
    sendButton: state.sendButton,
    chatMessages: state.chatMessages,
  });
}

function isRoomPage() {
  return /\/films\/\d+/i.test(location.pathname);
}

function findChatPanel() {
  return document.querySelector('.watch-party-ui');
}

function findChatInput(root) {
  return (
    root.querySelector('#wp-chat-input') ??
    root.querySelector('.wp-chat-input') ??
    root.querySelector('input[placeholder*="Написать"], textarea[placeholder*="Написать"]')
  );
}

function findSendButton(root) {
  return (
    root.querySelector('#wp-chat-send') ??
    root.querySelector('.wp-chat-send')
  );
}

function findHeaderControls(root) {
  return (
    root.querySelector('.wp-controls') ??
    root.querySelector('#wp-minimize')?.parentElement ??
    root.querySelector('.wp-header')
  );
}

function findChatMessages(root) {
  const connected = document.querySelectorAll('#wp-chat-messages, .wp-chat-messages');
  for (const element of connected) {
    if (element.isConnected) {
      return element;
    }
  }

  return (
    root?.querySelector('#wp-chat-messages') ??
    root?.querySelector('.wp-chat-messages') ??
    null
  );
}

function countChatMessages(container) {
  if (!container) {
    return 0;
  }

  const tagged = container.querySelectorAll('.wp-chat-message');
  if (tagged.length > 0) {
    return tagged.length;
  }

  return container.childElementCount;
}

function resolveLiveChatMessages() {
  const element = findChatMessages(state.chatPanel ?? findChatPanel());
  if (element?.isConnected) {
    return element;
  }

  return null;
}

function createPopoutButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'wp-btn reyohoho-ext-popout-btn';
  button.title = 'Вынести чат в отдельное окно';
  button.setAttribute('aria-label', 'Pop out chat');
  button.innerHTML = `
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path fill="currentColor" d="M14 3h7v7h-2V6.41l-9.29 9.3-1.42-1.42 9.3-9.29H14V3zm-2 2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7h-2v7H5V7h7V5z"/>
    </svg>
  `;
  button.addEventListener('click', openPopoutWindow);
  return button;
}

async function openPopoutWindow() {
  state.popoutSession += 1;
  const session = state.popoutSession;

  cancelPopoutDisconnect();
  ensurePopoutHostPort();

  const rect = state.chatPanel?.getBoundingClientRect();
  const left = rect ? Math.round(window.screenX + rect.right + 12) : undefined;
  const top = rect ? Math.round(window.screenY + rect.top) : undefined;

  const response = await sendMessage({
    type: 'OPEN_POPOUT',
    width: 420,
    height: 820,
    left,
    top,
  });

  if (!response?.ok) {
    console.warn('[ReYohoho Chat] Failed to open pop-out:', response?.error);
    return;
  }

  if (session !== state.popoutSession) {
    return;
  }

  state.popoutOpen = true;
  hideChatPanelForPopout();
  startPopoutHostSync(true);
  pushPopoutFullSync();
}

function ensurePopoutHostPort() {
  if (state.popoutHostPort) {
    return;
  }

  const port = chrome.runtime.connect({ name: 'reyohoho-popout-host' });
  state.popoutHostPort = port;

  port.onMessage.addListener(handlePopoutPortMessage);
  port.onDisconnect.addListener(() => {
    state.popoutHostPort = null;
    if (state.popoutOpen) {
      restoreChatPanelAfterPopout();
      state.popoutOpen = false;
      stopPopoutHostSync();
    }
  });
}

function refreshChatDomRefs() {
  const panel = findChatPanel();
  if (!panel) {
    return false;
  }

  const prevInput = state.chatInput;
  const prevSend = state.sendButton;
  const prevMessages = state.chatMessages;

  state.chatPanel = panel;
  state.chatInput = findChatInput(panel);
  state.sendButton = findSendButton(panel);
  state.headerControls = findHeaderControls(panel);
  state.chatMessages = resolveLiveChatMessages();

  if (
    state.chatInput &&
    (state.chatInput !== prevInput || state.sendButton !== prevSend)
  ) {
    bindHostChat();
  }

  if (state.chatMessages && state.chatMessages !== prevMessages) {
    restartMainChatObserver();
    if (state.popoutOpen) {
      restartPopoutSyncObserver();
    }
  }

  return Boolean(state.chatInput && state.chatMessages);
}

function buildPopoutSyncPayload(options = {}) {
  refreshChatDomRefs();
  state.chatMessages = resolveLiveChatMessages();

  const messagesEl = state.chatMessages;
  const messagesHtml = messagesEl?.innerHTML ?? '';
  state.popoutSyncSeq += 1;

  const header = state.chatPanel?.querySelector('.wp-header');

  return {
    headerHtml: sanitizeHeaderHtmlForPopout(header?.innerHTML ?? ''),
    messagesHtml,
    messageCount: countChatMessages(messagesEl),
    syncSeq: state.popoutSyncSeq,
    title: 'ReYohoho — Чат',
    stylesheetUrls: collectPopoutStylesheetUrls(),
    inlineThemeCss: collectPopoutInlineThemeCss(),
    replaceAllMessages: Boolean(options.replaceAllMessages),
  };
}

function pushPopoutFullSync() {
  if (!state.popoutHostPort) {
    return;
  }

  state.popoutOpen = true;
  state.popoutHostPort.postMessage({
    type: 'SYNC_TO_POPOUT',
    payload: buildPopoutSyncPayload({ replaceAllMessages: true }),
  });
}

function sanitizeHeaderHtmlForPopout(html) {
  if (!html) {
    return '';
  }

  const template = document.createElement('template');
  template.innerHTML = html;

  for (const selector of [
    '.reyohoho-ext-popout-btn',
    '#wp-minimize',
    '#wp-expand',
    '[title="Свернуть"]',
    '[title="Развернуть"]',
  ]) {
    for (const node of template.content.querySelectorAll(selector)) {
      node.remove();
    }
  }

  return template.innerHTML;
}

function collectPopoutStylesheetUrls() {
  const urls = new Set();

  for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
    if (link.href) {
      urls.add(link.href);
    }
  }

  return [...urls];
}

function collectPopoutInlineThemeCss() {
  const chunks = [];

  for (const style of document.querySelectorAll('style')) {
    const text = style.textContent ?? '';
    if (/\.wp-|\.watch-party/i.test(text)) {
      chunks.push(text);
    }
  }

  for (const sheet of document.styleSheets) {
    try {
      const rules = sheet.cssRules;
      if (!rules) {
        continue;
      }

      let block = '';
      for (const rule of rules) {
        const cssText = rule.cssText ?? '';
        if (/\.wp-|\.watch-party/i.test(cssText)) {
          block += `${cssText}\n`;
        }
      }

      if (block) {
        chunks.push(block);
      }
    } catch {
      // Cross-origin stylesheet — loaded via stylesheetUrls instead.
    }
  }

  return chunks.join('\n');
}

function isChatPanelMinimized() {
  const panel = state.chatPanel;
  if (!panel) {
    return false;
  }

  for (const className of ['minimized', 'collapsed', 'wp-minimized', 'wp-collapsed']) {
    if (panel.classList.contains(className)) {
      return true;
    }
  }

  const expandButton = panel.querySelector('#wp-expand, [title="Развернуть"]');
  const minimizeButton = panel.querySelector('#wp-minimize, [title="Свернуть"]');

  if (!expandButton) {
    return false;
  }

  const expandVisible =
    expandButton.offsetParent !== null && getComputedStyle(expandButton).display !== 'none';
  const minimizeVisible =
    !minimizeButton ||
    (minimizeButton.offsetParent !== null && getComputedStyle(minimizeButton).display !== 'none');

  return expandVisible && !minimizeVisible;
}

function getPopoutControlsContainer() {
  return state.chatPanel?.querySelector('.wp-controls') ?? state.headerControls;
}

function getPopoutButtonAnchor() {
  const header = state.chatPanel?.querySelector('.wp-header');
  const controls = getPopoutControlsContainer();

  if (controls?.parentElement === header) {
    return controls;
  }

  return controls ?? header;
}

function updatePopoutButtonVisibility() {
  if (!state.popoutButton) {
    return;
  }

  state.popoutButton.hidden = isChatPanelMinimized();
}

function mountPopoutButton() {
  if (!state.popoutButton) {
    return;
  }

  const anchor = getPopoutButtonAnchor();
  if (!anchor) {
    return;
  }

  if (
    state.popoutButton.parentElement === anchor.parentElement &&
    state.popoutButton.previousElementSibling === anchor
  ) {
    updatePopoutButtonVisibility();
    return;
  }

  anchor.insertAdjacentElement('afterend', state.popoutButton);
  updatePopoutButtonVisibility();
}

function ensurePopoutButton() {
  mountPopoutButton();
}

function schedulePopoutControlsMaintenance() {
  clearTimeout(state.popoutControlsTimer);
  state.popoutControlsTimer = setTimeout(() => {
    state.popoutControlsTimer = null;
    ensurePopoutButton();
    if (state.popoutOpen) {
      pushPopoutSync();
    }
  }, 100);
}

function observePopoutControls() {
  if (state.popoutControlsObserver) {
    return;
  }

  const header = state.chatPanel?.querySelector('.wp-header');
  const panel = state.chatPanel;
  if (!header && !panel) {
    return;
  }

  state.popoutControlsObserver = new MutationObserver(() => {
    schedulePopoutControlsMaintenance();
  });

  if (header) {
    state.popoutControlsObserver.observe(header, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
  }

  if (panel) {
    state.popoutControlsObserver.observe(panel, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
  }
}

function stopPopoutControlsObserver() {
  state.popoutControlsObserver?.disconnect();
  state.popoutControlsObserver = null;
  clearTimeout(state.popoutControlsTimer);
  state.popoutControlsTimer = null;
}

function pushPopoutSync() {
  if (!state.popoutOpen || !state.popoutHostPort) {
    return;
  }

  clearTimeout(state.popoutSyncTimer);
  state.popoutSyncTimer = setTimeout(() => {
    state.popoutHostPort?.postMessage({
      type: 'SYNC_TO_POPOUT',
      payload: buildPopoutSyncPayload({ replaceAllMessages: false }),
    });
  }, 16);
}

function hideChatPanelForPopout() {
  state.chatPanel?.classList.add('reyohoho-host-popout-hidden');
}

function restoreChatPanelAfterPopout() {
  state.chatPanel?.classList.remove('reyohoho-host-popout-hidden');
}

function startPopoutHostSync(forceRestartInterval = false) {
  refreshChatDomRefs();

  if (!state.chatMessages) {
    return;
  }

  restartPopoutSyncObserver();
  startGlobalPopoutMessageWatcher();

  if (state.popoutSyncInterval) {
    if (!forceRestartInterval) {
      return;
    }

    clearInterval(state.popoutSyncInterval);
    state.popoutSyncInterval = null;
  }

  state.popoutSyncInterval = window.setInterval(() => {
    pushPopoutSync();
  }, 300);
}

function startGlobalPopoutMessageWatcher() {
  state.globalPopoutWatcher?.disconnect();
  state.globalPopoutWatcher = null;

  state.globalPopoutWatcher = new MutationObserver(() => {
    const panel = findChatPanel();
    if (panel && panel !== state.chatPanel) {
      state.chatPanel = panel;
    }

    const liveMessages = resolveLiveChatMessages();
    if (liveMessages && liveMessages !== state.chatMessages) {
      state.chatMessages = liveMessages;
      restartMainChatObserver();
      restartPopoutSyncObserver();
    }

    pushPopoutSync();
  });

  const watchRoot = state.chatPanel ?? document.documentElement;
  state.globalPopoutWatcher.observe(watchRoot, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

function restartPopoutSyncObserver() {
  state.popoutSyncObserver?.disconnect();
  state.popoutSyncObserver = null;

  if (!state.chatMessages) {
    return;
  }

  state.popoutSyncObserver = new MutationObserver(() => {
    pushPopoutSync();
  });

  state.popoutSyncObserver.observe(state.chatMessages, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  const header = state.chatPanel?.querySelector('.wp-header');
  if (header) {
    state.popoutSyncObserver.observe(header, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }
}

function stopPopoutHostSync() {
  state.popoutSyncObserver?.disconnect();
  state.popoutSyncObserver = null;
  state.globalPopoutWatcher?.disconnect();
  state.globalPopoutWatcher = null;
  clearTimeout(state.popoutSyncTimer);
  state.popoutSyncTimer = null;
  clearTimeout(state.popoutDisconnectTimer);
  state.popoutDisconnectTimer = null;

  if (state.popoutSyncInterval) {
    clearInterval(state.popoutSyncInterval);
    state.popoutSyncInterval = null;
  }
}

function markPopoutDisconnected() {
  if (state.popoutDisconnectTimer) {
    clearTimeout(state.popoutDisconnectTimer);
  }

  restoreChatPanelAfterPopout();

  state.popoutDisconnectTimer = window.setTimeout(() => {
    state.popoutDisconnectTimer = null;
    state.popoutOpen = false;
    stopPopoutHostSync();
  }, 300);
}

function cancelPopoutDisconnect() {
  if (state.popoutDisconnectTimer) {
    clearTimeout(state.popoutDisconnectTimer);
    state.popoutDisconnectTimer = null;
  }
}

function handlePopoutPortMessage(message) {
  switch (message.type) {
    case 'POPOUT_CONNECTED':
    case 'POPOUT_READY':
    case 'REQUEST_SYNC':
      cancelPopoutDisconnect();
      state.popoutOpen = true;
      hideChatPanelForPopout();
      startPopoutHostSync(true);
      pushPopoutFullSync();
      window.setTimeout(() => pushPopoutFullSync(), 100);
      window.setTimeout(() => pushPopoutFullSync(), 500);
      break;
    case 'POPOUT_DISCONNECTED':
      markPopoutDisconnected();
      break;
    case 'POPOUT_CLOSING': {
      const session = state.popoutSession;
      restoreChatPanelAfterPopout();
      window.setTimeout(() => {
        if (session !== state.popoutSession) {
          return;
        }

        markPopoutDisconnected();
      }, 0);
      break;
    }
    case 'SEND':
      handlePopoutSend(message);
      break;
    default:
      break;
  }
}

function triggerHostChatSend() {
  const input = state.chatInput;
  const sendButton = state.sendButton;
  if (!input) {
    return;
  }

  input.focus({ preventScroll: true });

  const form = input.closest('form');
  if (form?.requestSubmit) {
    form.requestSubmit();
  }

  sendButton?.click();

  for (const type of ['keydown', 'keypress', 'keyup']) {
    input.dispatchEvent(
      new KeyboardEvent(type, {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      }),
    );
  }
}

async function handlePopoutSend(message) {
  refreshChatDomRefs();
  if (!state.chatInput) {
    return;
  }

  const value = message?.value ?? '';
  if (!hostChat.stripEmoteMetadata(value.trim())) {
    return;
  }

  state.chatInput.value = value;
  state.chatInput.dispatchEvent(new Event('input', { bubbles: true }));
  state.chatInput.dispatchEvent(new Event('change', { bubbles: true }));

  triggerHostChatSend();
  window.setTimeout(() => pushPopoutFullSync(), 50);
  window.setTimeout(() => pushPopoutFullSync(), 250);
  window.setTimeout(() => pushPopoutSync(), 500);
}

function insertPopoutButton() {
  observePopoutControls();

  if (state.popoutButton) {
    ensurePopoutButton();
    return;
  }

  if (!getPopoutButtonAnchor()) {
    return;
  }

  state.popoutButton = createPopoutButton();
  mountPopoutButton();
}


function restartMainChatObserver() {
  state.observer?.disconnect();
  state.observer = null;
  observeChatMessages();
}

function observeChatMessages() {
  if (!state.chatMessages || state.observer) {
    return;
  }

  state.observer = new MutationObserver(() => {
    hostChat.scheduleRenderMessages(state.chatMessages);
    pushPopoutSync();
  });

  state.observer.observe(state.chatMessages, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

function bindDomWatcher() {
  let lastHref = location.href;

  const domObserver = new MutationObserver(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      state.initialized = false;
      state.chatPanel = null;
      state.popoutButton = null;
      state.popoutOpen = false;
      stopPopoutControlsObserver();
      stopPopoutHostSync();
      restoreChatPanelAfterPopout();
      state.observer?.disconnect();
      state.observer = null;
    }

    if (!state.initialized) {
      bootstrap();
    }
  });

  domObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

async function bootstrap() {
  if (!isRoomPage()) {
    return;
  }

  const panel = findChatPanel();
  if (!panel) {
    return;
  }

  state.chatPanel = panel;
  state.chatInput = findChatInput(panel);
  state.sendButton = findSendButton(panel);
  state.headerControls = findHeaderControls(panel);
  state.chatMessages = findChatMessages(panel);

  if (!state.chatInput || !state.chatMessages) {
    return;
  }

  state.initialized = true;

  bindHostChat();
  await Promise.all([hostChat.loadEmotes(), hostChat.loadHistory()]);
  ensurePopoutHostPort();
  insertPopoutButton();
  hostChat.setupTooltips();
  observeChatMessages();
  hostChat.renderMessages(state.chatMessages);
}

bindDomWatcher();
bootstrap();
