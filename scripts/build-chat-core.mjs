import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);
const mainPath = new URL('../content/main.js', import.meta.url);
const outPath = new URL('../shared/chat-core.js', import.meta.url);

const source = fs.readFileSync(mainPath, 'utf8');
const start = source.indexOf('function escapeHtml(value)');
const end = source.indexOf('function restartMainChatObserver()');
if (start < 0 || end < 0) {
  throw new Error('Could not locate chat core block in main.js');
}

let body = source.slice(start, end);
body = body.replace(
  /^let resolveEmotesTimer = null;\s*let resolveEmotesInFlight = false;\s*let renderEmotesTimer = null;\s*/m,
  '',
);

const header = `(() => {
  const HISTORY_KEY = 'messageHistory';
  const MAX_HISTORY = 100;

  function createController(options = {}) {
    const sendRuntimeMessage =
      options.sendRuntimeMessage ??
      ((message) =>
        new Promise((resolve) => {
          chrome.runtime.sendMessage(message, (response) => {
            resolve(response ?? { ok: false, error: chrome.runtime.lastError?.message });
          });
        }));

    const onActivity = typeof options.onActivity === 'function' ? options.onActivity : () => {};
    const onSendPrepared =
      typeof options.onSendPrepared === 'function' ? options.onSendPrepared : null;

    const state = {
      chatInput: null,
      sendButton: null,
      chatMessages: null,
      inputMirror: null,
      inputShell: null,
      composePreviewHint: options.composeHintEl ?? null,
      emotes: { sevenTv: {} },
      emotesById: {},
      composeSelections: new Map(),
      composePreview: null,
      emoteTooltipEl: null,
      emoteTooltipTarget: null,
      history: [],
      historyIndex: -1,
      draftBeforeHistory: '',
      suppressInputEvents: false,
      bound: false,
    };

    let resolveEmotesTimer = null;
    let resolveEmotesInFlight = false;
    let renderEmotesTimer = null;

`;

const footer = `
    function bind({
      chatInput,
      sendButton,
      chatMessages,
      composeHintEl = null,
      inputMirror = null,
      inputShell = null,
      setupMirrorShell = true,
    } = {}) {
      state.chatInput = chatInput ?? state.chatInput;
      state.sendButton = sendButton ?? state.sendButton;
      state.chatMessages = chatMessages ?? state.chatMessages;
      state.composePreviewHint = composeHintEl ?? state.composePreviewHint;
      state.inputMirror = inputMirror ?? state.inputMirror;
      state.inputShell = inputShell ?? state.inputShell;

      if (state.chatInput && !state.chatInput.dataset.reyohohoPreview) {
        setupInputPreview();
      } else if (state.chatInput && state.inputMirror) {
        wireInputPreviewListeners(state.chatInput);
      }

      bindInputHandlers();
      bindSendHandlers(onSendPrepared);
      state.bound = Boolean(state.chatInput);
    }

    async function prepareOutgoingMessage() {
      injectMetadataBeforeSend();
      const raw = state.chatInput?.value ?? '';
      const text = stripEmoteMetadata(raw.trim());
      if (!text) {
        return null;
      }

      const unknown = collectUnknownEmoteTokensFromText(text);
      if (unknown.size > 0) {
        await resolveEmoteNames([...unknown]);
        if (state.chatMessages) {
          renderEmotesInContainer(state.chatMessages);
        }
      }

      return state.chatInput?.value ?? null;
    }

    async function handlePopoutSendLocal(event) {
      if (event?.preventDefault) {
        event.preventDefault();
      }

      const prepared = await prepareOutgoingMessage();
      if (!prepared) {
        return null;
      }

      queueMicrotask(captureOutgoingMessage);
      syncInputMirrorAfterSend();
      clearComposePreview();
      clearInput();
      onActivity();

      if (onSendPrepared) {
        await onSendPrepared(prepared);
      }

      return prepared;
    }

    function clearInput() {
      if (!state.chatInput) {
        return;
      }

      state.suppressInputEvents = true;
      setInputValue(state.chatInput, '');
      state.suppressInputEvents = false;
      syncInputMirrorAfterSend();
      onActivity();
    }

    function setExternalInputValue(value) {
      if (!state.chatInput) {
        return;
      }

      state.suppressInputEvents = true;
      setInputValue(state.chatInput, value ?? '');
      state.suppressInputEvents = false;
    }

    return {
      bind,
      loadEmotes,
      loadHistory,
      renderMessages: renderEmotesInContainer,
      scheduleRenderMessages: scheduleRenderEmotes,
      setupTooltips: setupEmoteTooltips,
      prepareOutgoingMessage,
      handlePopoutSendLocal,
      clearInput,
      setExternalInputValue,
      stripEmoteMetadata,
      getInputValue: () => state.chatInput?.value ?? '',
    };
  }

  globalThis.ReYohohoChat = { createController, HISTORY_KEY: 'messageHistory', MAX_HISTORY: 100 };
})();
`;

let transformed = body
  .replace(/\bsendMessage\(/g, 'sendRuntimeMessage(')
  .replace(/\bpushPopoutSync\(\)/g, 'onActivity()')
  .replace(/function bindSendHandlers\(\) \{[\s\S]*?\n\}/, `function bindSendHandlers(onSendPrepared) {
  if (!state.sendButton || state.sendButton.dataset.reyohohoSendHook === 'true') {
    return;
  }

  state.sendButton.dataset.reyohohoSendHook = 'true';

  const onSendClick = (event) => {
    if (onSendPrepared) {
      handlePopoutSendLocal(event);
      return;
    }

    onMessageSend();
  };

  state.sendButton.addEventListener('click', onSendClick, true);
  state.chatInput?.closest('form')?.addEventListener('submit', onSendClick, true);
}`)
  .replace(
    /state\.chatInput\.addEventListener\('keydown', \(event\) => \{\s*if \(event\.key === 'Enter'[\s\S]*?\}, true\);/,
    `state.chatInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      if (onSendPrepared) {
        handlePopoutSendLocal(event);
      } else {
        onMessageSend();
      }
    }
  }, true);`,
  );

fs.mkdirSync(path.dirname(fileURLToPath(outPath)), { recursive: true });
fs.writeFileSync(fileURLToPath(outPath), header + transformed + footer);
console.log('Wrote shared/chat-core.js');
