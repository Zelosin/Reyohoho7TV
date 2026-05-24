(() => {
  const EXTENSION_STYLES = [
    'content/styles.css',
    'chat-popout-theme.css',
    'chat-popout.css',
  ];

  for (const path of EXTENSION_STYLES) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL(path);
    document.head.append(link);
  }

  const params = new URLSearchParams(location.search);
  const hostTabId = Number(params.get('hostTabId'));
  if (!Number.isFinite(hostTabId)) {
    document.body.textContent = 'Не удалось подключиться к вкладке с комнатой.';
    return;
  }

  const root = document.getElementById('reyohoho-popout-root');
  const headerEl = document.getElementById('reyohoho-popout-header');
  const messagesEl = document.getElementById('wp-chat-messages');
  const inputEl = document.getElementById('wp-chat-input');
  const sendEl = document.getElementById('wp-chat-send');
  const statusEl = document.getElementById('reyohoho-popout-status');
  const composeHintEl = document.getElementById('reyohoho-popout-compose-hint');
  const inputMirrorEl = document.getElementById('reyohoho-popout-input-mirror');
  const inputShellEl = inputEl?.closest('.reyohoho-input-shell');

  let port = null;
  let messagesAtBottom = true;
  let reconnectTimer = null;
  let lastAppliedSyncSeq = 0;
  let lastAppliedMessageCount = 0;
  const loadedThemeUrls = new Set();
  let inlineThemeStyleEl = null;

  const popoutChat = ReYohohoChat.createController({
    onSendPrepared: (prepared) => {
      post('SEND', { value: prepared });
    },
  });

  function applyTheme(payload) {
    if (Array.isArray(payload.stylesheetUrls)) {
      for (const url of payload.stylesheetUrls) {
        if (!url || loadedThemeUrls.has(url)) {
          continue;
        }

        loadedThemeUrls.add(url);
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = url;
        document.head.append(link);
      }
    }

    if (payload.inlineThemeCss) {
      if (!inlineThemeStyleEl) {
        inlineThemeStyleEl = document.createElement('style');
        inlineThemeStyleEl.id = 'reyohoho-popout-theme-inline';
        document.head.append(inlineThemeStyleEl);
      }

      if (inlineThemeStyleEl.textContent !== payload.inlineThemeCss) {
        inlineThemeStyleEl.textContent = payload.inlineThemeCss;
      }
    }
  }

  function showStatus(text) {
    statusEl.hidden = false;
    statusEl.textContent = text;
    root.hidden = true;
  }

  function hideStatus() {
    statusEl.hidden = true;
    root.hidden = false;
  }

  function connect() {
    if (port) {
      try {
        port.disconnect();
      } catch {
        // Port already disconnected.
      }
      port = null;
    }

    port = chrome.runtime.connect({ name: `reyohoho-popout-window:${hostTabId}` });

    port.onMessage.addListener((message) => {
      if (message.type === 'SYNC') {
        applySync(message.payload);
      } else if (message.type === 'HOST_DISCONNECTED') {
        showStatus('Вкладка с комнатой закрыта. Можно закрыть это окно.');
      }
    });

    port.onDisconnect.addListener(() => {
      port = null;
      showStatus('Соединение потеряно. Переподключение…');
      scheduleReconnect();
    });

    hideStatus();
    port.postMessage({ type: 'POPOUT_READY' });
    port.postMessage({ type: 'REQUEST_SYNC' });
  }

  function scheduleReconnect() {
    if (reconnectTimer) {
      return;
    }

    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 500);
  }

  function countLocalMessages() {
    const tagged = messagesEl.querySelectorAll('.wp-chat-message');
    if (tagged.length > 0) {
      return tagged.length;
    }

    return messagesEl.childElementCount;
  }

  function applyMessages(payload) {
    if (payload.messagesHtml == null) {
      return;
    }

    const remoteCount = Number(payload.messageCount) || 0;
    const localCount = countLocalMessages();
    const hasPayloadMessages = Boolean(payload.messagesHtml.trim());
    const popoutEmpty = localCount === 0 && !messagesEl.textContent?.trim();
    const htmlChanged = messagesEl.innerHTML !== payload.messagesHtml;
    const countIncreased = remoteCount > localCount;
    const forceReplace = Boolean(payload.replaceAllMessages);

    if (
      !forceReplace &&
      !htmlChanged &&
      !countIncreased &&
      !(popoutEmpty && hasPayloadMessages)
    ) {
      return;
    }

    if (forceReplace) {
      messagesEl.replaceChildren();
      messagesAtBottom = true;
    }

    messagesEl.innerHTML = payload.messagesHtml;
    lastAppliedMessageCount = remoteCount || countLocalMessages();
    popoutChat.renderMessages(messagesEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function applySync(payload) {
    if (!payload) {
      return;
    }

    const syncSeq = Number(payload.syncSeq) || 0;
    if (syncSeq > 0 && syncSeq < lastAppliedSyncSeq && !payload.replaceAllMessages) {
      return;
    }

    if (syncSeq > 0) {
      lastAppliedSyncSeq = syncSeq;
    }

    hideStatus();
    applyTheme(payload);

    if (payload.headerHtml != null && headerEl.innerHTML !== payload.headerHtml) {
      headerEl.innerHTML = payload.headerHtml;
    }

    applyMessages(payload);

    if (payload.title) {
      document.title = payload.title;
    }
  }

  function post(type, extra = {}) {
    port?.postMessage({ type, ...extra });
  }

  messagesEl.addEventListener('scroll', () => {
    messagesAtBottom =
      messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 48;
  });

  window.addEventListener('beforeunload', () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    post('POPOUT_CLOSING');
  });

  async function init() {
    connect();

    await Promise.all([popoutChat.loadEmotes(), popoutChat.loadHistory()]);
    popoutChat.bind({
      chatInput: inputEl,
      sendButton: sendEl,
      chatMessages: messagesEl,
      composeHintEl,
      inputMirror: inputMirrorEl,
      inputShell: inputShellEl,
    });
    popoutChat.setupTooltips();
    post('REQUEST_SYNC');
  }

  init();
})();
