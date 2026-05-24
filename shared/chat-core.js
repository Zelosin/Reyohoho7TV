(() => {
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
    let resolveEmotesPending = false;
    let renderEmotesTimer = null;

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** При совпадении имён побеждает первый добавленный источник. */
function mergeEmotesFirstWins(...maps) {
  const result = {};

  for (const map of maps) {
    if (!map) continue;
    for (const [name, url] of Object.entries(map)) {
      if (!Object.prototype.hasOwnProperty.call(result, name)) {
        result[name] = url;
      }
    }
  }

  return result;
}

const MIN_EMOTE_LOOKUP_LENGTH = 2;

/** Невидимая метка выбранного эмота — видна только расширению. */
const EMOTE_META_SUFFIX_PATTERN =
  /^\u200Bryh:7tv:([A-Za-z0-9]+)(?:\u200D([^\u200C]+))?\u200C/;
const EMOTE_META_PATTERN =
  /\u200Bryh:7tv:([A-Za-z0-9]+)(?:\u200D[^\u200C]+)?\u200C/g;

function buildEmoteMeta(provider, id, name = null) {
  const base = `\u200Bryh:7tv:${id}`;
  if (name) {
    return `${base}\u200D${name}\u200C`;
  }

  return `${base}\u200C`;
}

function parseEmoteMetaSuffix(text, offset) {
  const match = text.slice(offset).match(EMOTE_META_SUFFIX_PATTERN);
  if (!match) {
    return null;
  }

  return {
    provider: '7tv',
    id: match[1],
    name: match[2] ?? null,
    length: match[0].length,
  };
}

function stripEmoteMetadata(text) {
  return text.replace(EMOTE_META_PATTERN, '');
}

function collectEmoteMetaSpans(text) {
  if (!text) {
    return [];
  }

  const spans = [];
  const pattern = new RegExp(EMOTE_META_PATTERN.source, 'g');

  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    spans.push({ start, end: start + match[0].length });
  }

  return spans;
}

function isInsideProtectedSpans(start, end, protectedSpans) {
  return protectedSpans.some(({ start: spanStart, end: spanEnd }) =>
    spansOverlap(start, end, spanStart, spanEnd),
  );
}

/** Латинские буквы подряд — английские слова в тексте сообщения. */
const ENGLISH_WORD_PATTERN = /[A-Za-z]{2,}/g;

function extractSevenTvIdFromUrl(url) {
  const match = String(url).match(/\/emote\/([A-Za-z0-9]+)\//);
  return match?.[1] ?? null;
}

function registerEmoteEntry(provider, id, name, url) {
  if (!provider || !id || !url) {
    return;
  }

  state.emotesById[`${provider}:${id}`] = { name: name ?? id, url };
}

function registerEmoteMap(provider, map, idFromUrl) {
  if (!map) {
    return;
  }

  for (const [name, url] of Object.entries(map)) {
    const id = idFromUrl(url);
    if (id) {
      registerEmoteEntry(provider, id, name, url);
    }
  }
}

function lookupEmoteById(provider, id) {
  if (provider !== '7tv') {
    return null;
  }

  const key = `7tv:${id}`;
  if (state.emotesById[key]) {
    return state.emotesById[key];
  }

  return {
    name: id,
    url: `https://cdn.7tv.app/emote/${id}/2x.webp`,
  };
}

function registerEmoteCandidates(candidates) {
  for (const candidate of candidates ?? []) {
    registerEmoteEntry(candidate.provider, candidate.id, candidate.name, candidate.url);
  }
}

async function searchEmoteCandidates(query) {
  const response = await sendRuntimeMessage({
    type: 'SEARCH_EMOTE_CANDIDATES',
    query,
  });

  if (!response?.ok) {
    return [];
  }

  const candidates = response.data?.candidates ?? [];
  registerEmoteCandidates(candidates);
  return candidates;
}

function stripTokenEdges(raw) {
  return raw.replace(/^[^\w+-]+|[^\w+-]+$/g, '');
}

function isEnglishWord(token) {
  return /^[A-Za-z]+$/.test(token) && token.length >= MIN_EMOTE_LOOKUP_LENGTH;
}

/** Фрагменты текста для проверки в карте эмотов (без regex по именам эмотов). */
function collectTextWordSpans(text) {
  if (!text) {
    return [];
  }

  const spans = [];
  const seen = new Set();

  const addSpan = (start, end, token) => {
    if (!token || token.length < MIN_EMOTE_LOOKUP_LENGTH) {
      return;
    }
    if (/^\d+$/.test(token)) {
      return;
    }

    const key = `${start}:${end}:${token}`;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    spans.push({ start, end, token });
  };

  for (const match of text.matchAll(ENGLISH_WORD_PATTERN)) {
    addSpan(match.index ?? 0, (match.index ?? 0) + match[0].length, match[0]);
  }

  for (const match of text.matchAll(/\S+/g)) {
    const raw = match[0];
    const token = stripTokenEdges(raw);
    if (isEnglishWord(token)) {
      continue;
    }

    const offset = raw.indexOf(token);
    if (offset < 0) {
      continue;
    }

    const start = (match.index ?? 0) + offset;
    addSpan(start, start + token.length, token);
  }

  return spans.sort((a, b) => a.start - b.start);
}

const DISCORD_ATTACHMENT_URL_PATTERN =
  /https:\/\/media\.discordapp\.net\/attachments\/\d+\/\d+\/[^\s<>"']+/gi;
const URL_IN_TEXT_PATTERN = /https?:\/\/[^\s<>"']+/gi;

function spansOverlap(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

function isInsideUrlSpans(start, end, urlSpans) {
  return urlSpans.some(({ start: urlStart, end: urlEnd }) =>
    spansOverlap(start, end, urlStart, urlEnd),
  );
}

function collectUrlSpans(text) {
  if (!text) {
    return [];
  }

  const spans = [];
  const pattern = new RegExp(URL_IN_TEXT_PATTERN.source, 'gi');

  for (const match of text.matchAll(pattern)) {
    const url = match[0];
    const start = match.index ?? 0;
    spans.push({ start, end: start + url.length, url });
  }

  return spans;
}

function isDiscordAttachmentUrl(url) {
  return /^https:\/\/media\.discordapp\.net\/attachments\/\d+\/\d+\//i.test(url);
}

function renderDiscordLinkHtml(url) {
  const safeUrl = escapeHtml(url);
  return `<a class="reyohoho-chat-link" href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a>`;
}

function collectDiscordAttachmentUrls(text) {
  return collectUrlSpans(text).filter(({ url }) => isDiscordAttachmentUrl(url));
}

function textHasDiscordAttachmentUrls(text) {
  if (!text) {
    return false;
  }

  return new RegExp(DISCORD_ATTACHMENT_URL_PATTERN.source, 'i').test(text);
}

function preregisterEmotesFromMetadata(text) {
  if (!text) {
    return;
  }

  const pattern = new RegExp(EMOTE_META_PATTERN.source, 'g');
  for (const match of text.matchAll(pattern)) {
    const id = match[1];
    if (!id) {
      continue;
    }

    registerEmoteEntry(
      '7tv',
      id,
      match[2] ?? id,
      `https://cdn.7tv.app/emote/${id}/2x.webp`,
    );
  }
}

function collectRichReplacements(text, emoteMap) {
  const urlSpans = collectUrlSpans(text);
  const metaSpans = collectEmoteMetaSpans(text);
  const replacements = [];

  for (const { start, end, token } of collectTextWordSpans(text)) {
    if (isInsideUrlSpans(start, end, urlSpans) || isInsideProtectedSpans(start, end, metaSpans)) {
      continue;
    }

    const meta = parseEmoteMetaSuffix(text, end);
    let url = null;
    let displayName = token;
    let renderMeta = null;

    if (meta) {
      const entry = lookupEmoteById(meta.provider, meta.id);
      if (entry) {
        url = entry.url;
        const cachedName = entry.name && entry.name !== meta.id ? entry.name : null;
        displayName = meta.name ?? cachedName ?? token;
        renderMeta = { provider: meta.provider, id: meta.id };
      }
    }

    if (!url) {
      url = lookupEmoteUrl(emoteMap, token);
    }

    if (!url) {
      continue;
    }

    replacements.push({
      start,
      end: meta ? end + meta.length : end,
      html: renderEmoteHtml(displayName, url, renderMeta, token),
    });
  }

  for (const { start, end, url } of collectDiscordAttachmentUrls(text)) {
    replacements.push({
      start,
      end,
      html: renderDiscordLinkHtml(url),
    });
  }

  replacements.sort((a, b) => a.start - b.start);

  const filtered = [];
  let lastEnd = 0;
  for (const replacement of replacements) {
    if (replacement.start < lastEnd) {
      continue;
    }

    filtered.push(replacement);
    lastEnd = replacement.end;
  }

  for (const { start, end } of metaSpans) {
    if (filtered.some((replacement) => replacement.start <= start && replacement.end >= end)) {
      continue;
    }

    const meta = parseEmoteMetaSuffix(text, start);
    if (!meta) {
      continue;
    }

    const entry = lookupEmoteById(meta.provider, meta.id);
    if (!entry) {
      continue;
    }

    let tokenStart = start;
    while (tokenStart > 0 && !/\s/.test(text[tokenStart - 1])) {
      tokenStart -= 1;
    }

    const token = text.slice(tokenStart, start);
    if (!token.trim()) {
      continue;
    }

    filtered.push({
      start: tokenStart,
      end: start + meta.length,
      html: renderEmoteHtml(
        meta.name ?? entry.name ?? token,
        entry.url,
        { provider: meta.provider, id: meta.id },
        token,
      ),
    });
  }

  filtered.sort((a, b) => a.start - b.start);

  const deduped = [];
  lastEnd = 0;
  for (const replacement of filtered) {
    if (replacement.start < lastEnd) {
      continue;
    }

    deduped.push(replacement);
    lastEnd = replacement.end;
  }

  return deduped;
}

function getEmoteWrapLabel(wrap) {
  if (!(wrap instanceof HTMLElement)) {
    return '';
  }

  return (
    wrap.dataset.emoteName ??
    wrap.getAttribute('data-emote-name') ??
    wrap.getAttribute('title') ??
    wrap.querySelector('img')?.getAttribute('alt') ??
    ''
  ).trim();
}

function ensureEmoteTooltip() {
  if (!state.emoteTooltipEl) {
    const tooltip = document.createElement('div');
    tooltip.className = 'reyohoho-emote-tooltip';
    tooltip.hidden = true;
    document.body.append(tooltip);
    state.emoteTooltipEl = tooltip;
  }

  return state.emoteTooltipEl;
}

function positionEmoteTooltip(wrap) {
  const tooltip = ensureEmoteTooltip();
  const rect = wrap.getBoundingClientRect();
  tooltip.style.left = `${rect.left + rect.width / 2}px`;
  tooltip.style.top = `${rect.top}px`;
}

function showEmoteTooltip(wrap) {
  const label = getEmoteWrapLabel(wrap);
  if (!label) {
    hideEmoteTooltip();
    return;
  }

  const tooltip = ensureEmoteTooltip();
  tooltip.textContent = label;
  tooltip.hidden = false;
  state.emoteTooltipTarget = wrap;
  positionEmoteTooltip(wrap);
}

function hideEmoteTooltip() {
  if (state.emoteTooltipEl) {
    state.emoteTooltipEl.hidden = true;
  }

  state.emoteTooltipTarget = null;
}

function setupEmoteTooltips() {
  if (document.documentElement.dataset.reyohohoEmoteTooltips === 'true') {
    return;
  }

  document.documentElement.dataset.reyohohoEmoteTooltips = 'true';

  document.addEventListener(
    'mouseover',
    (event) => {
      const wrap = event.target instanceof Element ? event.target.closest('.reyohoho-emote-wrap') : null;
      if (!wrap) {
        return;
      }

      showEmoteTooltip(wrap);
    },
    true,
  );

  document.addEventListener(
    'mouseout',
    (event) => {
      const wrap = event.target instanceof Element ? event.target.closest('.reyohoho-emote-wrap') : null;
      if (!wrap || state.emoteTooltipTarget !== wrap) {
        return;
      }

      const related = event.relatedTarget;
      if (related instanceof Node && wrap.contains(related)) {
        return;
      }

      hideEmoteTooltip();
    },
    true,
  );

  document.addEventListener(
    'scroll',
    () => {
      if (state.emoteTooltipTarget) {
        positionEmoteTooltip(state.emoteTooltipTarget);
      }
    },
    true,
  );

  window.addEventListener('resize', hideEmoteTooltip);
}

function renderEmoteHtml(code, url, meta = null, sourceToken = null) {
  const label = code || sourceToken || '';
  const token = sourceToken ?? label;
  const providerAttr = meta?.provider ? ` data-emote-provider="${escapeHtml(meta.provider)}"` : '';
  const idAttr = meta?.id ? ` data-emote-id="${escapeHtml(meta.id)}"` : '';
  const tokenAttr = token ? ` data-emote-token="${escapeHtml(token)}"` : '';
  const titleAttr = label ? ` title="${escapeHtml(label)}"` : '';
  return `<span class="reyohoho-emote-wrap" data-emote-name="${escapeHtml(label)}"${tokenAttr}${providerAttr}${idAttr}${titleAttr}><img class="reyohoho-emote" src="${url}" alt="${escapeHtml(label)}" loading="lazy"></span>`;
}

function renderEmotesInText(text, emoteMap) {
  if (!text) {
    return escapeHtml(text ?? '');
  }

  const replacements = collectRichReplacements(text, emoteMap);
  if (replacements.length === 0) {
    return escapeHtml(text);
  }

  let result = '';
  let lastIndex = 0;

  for (const { start, end, html } of replacements) {
    result += escapeHtml(text.slice(lastIndex, start));
    result += html;
    lastIndex = end;
  }

  result += escapeHtml(text.slice(lastIndex));
  return result;
}

function textHasRenderableEmotes(text, emoteMap) {
  if (!text?.trim()) {
    return false;
  }

  if (textHasDiscordAttachmentUrls(text)) {
    return true;
  }

  for (const { start } of collectEmoteMetaSpans(text)) {
    const meta = parseEmoteMetaSuffix(text, start);
    if (meta && lookupEmoteById(meta.provider, meta.id)) {
      return true;
    }
  }

  const urlSpans = collectUrlSpans(text);

  for (const { start, end, token } of collectTextWordSpans(text)) {
    if (isInsideUrlSpans(start, end, urlSpans)) {
      continue;
    }

    const meta = parseEmoteMetaSuffix(text, end);
    if (meta && lookupEmoteById(meta.provider, meta.id)) {
      return true;
    }

    if (lookupEmoteUrl(emoteMap, token)) {
      return true;
    }
  }

  return false;
}

function collectEmoteTokensFromText(text) {
  return collectTextWordSpans(text).map((span) => span.token);
}

function messageHasUnrenderedDiscordLinks(element) {
  const sourceText = getChatTextSourceText(element);
  if (!textHasDiscordAttachmentUrls(sourceText)) {
    return false;
  }

  const renderedUrls = new Set(
    [...element.querySelectorAll('.reyohoho-chat-link')].map(
      (link) => link.getAttribute('href') ?? link.href,
    ),
  );

  for (const { url } of collectDiscordAttachmentUrls(sourceText)) {
    if (!renderedUrls.has(url)) {
      return true;
    }
  }

  return false;
}

function messageHasUnrenderedEmotes(element, emoteMap) {
  const sourceText = getChatTextSourceText(element);
  if (messageHasUnrenderedDiscordLinks(element)) {
    return true;
  }

  if (!textHasRenderableEmotes(sourceText, emoteMap)) {
    return false;
  }

  const renderedKeys = new Set(
    [...element.querySelectorAll('.reyohoho-emote-wrap')].map((wrap) => {
      const provider = wrap.dataset.emoteProvider ?? wrap.getAttribute('data-emote-provider') ?? '';
      const id = wrap.dataset.emoteId ?? wrap.getAttribute('data-emote-id') ?? '';
      if (provider && id) {
        return `${provider}:${id}`;
      }

      return `name:${(wrap.dataset.emoteName ?? wrap.getAttribute('data-emote-name') ?? '').toLowerCase()}`;
    }),
  );

  const urlSpans = collectUrlSpans(sourceText);

  for (const { start, end, token } of collectTextWordSpans(sourceText)) {
    if (isInsideUrlSpans(start, end, urlSpans)) {
      continue;
    }

    const meta = parseEmoteMetaSuffix(sourceText, end);
    if (meta) {
      const key = `${meta.provider}:${meta.id}`;
      if (lookupEmoteById(meta.provider, meta.id) && !renderedKeys.has(key)) {
        return true;
      }
      continue;
    }

    if (lookupEmoteUrl(emoteMap, token) && !renderedKeys.has(`name:${token.toLowerCase()}`)) {
      return true;
    }
  }

  return false;
}

function getCombinedEmoteMap() {
  return state.emotes.sevenTv ?? {};
}

function shouldSkipElement(element) {
  if (!(element instanceof HTMLElement)) return true;
  if (element.closest('input, textarea, button, script, style, svg, label')) return true;
  if (element.classList.contains('reyohoho-emote')) return true;
  if (element.classList.contains('reyohoho-emote-wrap')) return true;
  if (element.classList.contains('reyohoho-chat-link')) return true;
  if (element.dataset.reyohohoEmoteProcessed === 'true') return true;
  if (element.classList.contains('reyohoho-ext-popout-btn')) return true;
  if (element.classList.contains('wp-chat-username')) return true;
  if (element.classList.contains('wp-chat-message') && element.classList.contains('system')) return true;

  return false;
}

function lookupEmoteUrl(emoteMap, token) {
  if (emoteMap[token]) {
    return emoteMap[token];
  }

  const lower = token.toLowerCase();
  for (const [name, url] of Object.entries(emoteMap)) {
    if (name.toLowerCase() === lower) {
      return url;
    }
  }

  return null;
}

function normalizeChatText(text) {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function clearStaleChatTextMetadata(element) {
  if (!(element instanceof HTMLElement)) {
    return;
  }

  const processed = element.querySelector('[data-reyohoho-emote-processed]');
  const liveText = normalizeChatText(element.textContent ?? '');

  if (processed) {
    return;
  }

  if (element.dataset.reyohohoSourceText != null) {
    const stored = normalizeChatText(element.dataset.reyohohoSourceText);
    if (stored !== liveText) {
      delete element.dataset.reyohohoSourceText;
    }
  }
}

function getChatTextSourceText(element) {
  if (!(element instanceof HTMLElement)) {
    return '';
  }

  clearStaleChatTextMetadata(element);

  const processed = element.querySelector('[data-reyohoho-emote-processed]');
  if (processed) {
    if (element.dataset.reyohohoSourceText != null) {
      return element.dataset.reyohohoSourceText;
    }

    return reconstructSourceFromProcessedSpan(processed);
  }

  return element.textContent ?? '';
}

function reconstructSourceFromProcessedSpan(span) {
  if (!(span instanceof HTMLElement)) {
    return '';
  }

  if (span.dataset.reyohohoSourceText != null) {
    return span.dataset.reyohohoSourceText;
  }

  let result = '';
  for (const child of span.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      result += child.textContent ?? '';
    } else if (child instanceof HTMLElement) {
      if (child.classList.contains('reyohoho-emote-wrap')) {
        const token =
          child.dataset.emoteToken ??
          child.getAttribute('data-emote-token') ??
          child.dataset.emoteName ??
          child.getAttribute('data-emote-name') ??
          child.querySelector('img')?.getAttribute('alt') ??
          '';
        const name =
          child.dataset.emoteName ??
          child.getAttribute('data-emote-name') ??
          child.querySelector('img')?.getAttribute('alt') ??
          token;
        const provider =
          child.dataset.emoteProvider ?? child.getAttribute('data-emote-provider') ?? '';
        const id = child.dataset.emoteId ?? child.getAttribute('data-emote-id') ?? '';

        if (provider && id) {
          result += token + buildEmoteMeta(provider, id, name);
        } else {
          result += token;
        }
      } else if (child.dataset.reyohohoEmoteProcessed === 'true') {
        result += reconstructSourceFromProcessedSpan(child);
      } else {
        result += child.textContent ?? '';
      }
    }
  }

  return result;
}

function resetChatTextElement(element) {
  if (!(element instanceof HTMLElement)) {
    return;
  }

  const sourceText = getChatTextSourceText(element);
  const processed = element.querySelector('[data-reyohoho-emote-processed]');
  if (processed) {
    processed.replaceWith(document.createTextNode(sourceText));
  }

  if (sourceText) {
    element.dataset.reyohohoSourceText = sourceText;
  } else {
    delete element.dataset.reyohohoSourceText;
  }
}

function messageContainsAnyToken(sourceText, tokenNames) {
  if (!sourceText || tokenNames.length === 0) {
    return false;
  }

  const wanted = new Set(tokenNames.map((name) => name.toLowerCase()));
  for (const { token } of collectTextWordSpans(sourceText)) {
    if (wanted.has(token.toLowerCase())) {
      return true;
    }
  }

  return false;
}

function hasUnprocessedTextInElement(element) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);

  while (walker.nextNode()) {
    const parent = walker.currentNode.parentElement;
    if (parent && !shouldSkipElement(parent)) {
      const text = walker.currentNode.textContent ?? '';
      if (text.length > 0) {
        return true;
      }
    }
  }

  return false;
}

function collectUnknownEmoteTokensFromText(text, emoteMap = getCombinedEmoteMap()) {
  const unknown = new Set();
  const plainText = stripEmoteMetadata(text);
  const urlSpans = collectUrlSpans(plainText);

  preregisterEmotesFromMetadata(text);

  for (const { start, end, token } of collectTextWordSpans(plainText)) {
    if (isInsideUrlSpans(start, end, urlSpans)) {
      continue;
    }

    if (lookupEmoteUrl(emoteMap, token)) {
      continue;
    }

    if (!isEnglishWord(token)) {
      continue;
    }

    unknown.add(token);
  }

  return unknown;
}

function collectUnknownEmoteTokens(container) {
  const unknown = new Set();

  for (const element of container.querySelectorAll('.wp-chat-text')) {
    for (const token of collectUnknownEmoteTokensFromText(getChatTextSourceText(element))) {
      unknown.add(token);
    }
  }

  return unknown;
}

async function resolveEmoteNames(names) {
  if (!names.length) {
    return {};
  }

  const response = await sendRuntimeMessage({
    type: 'RESOLVE_7TV_EMOTES',
    names,
  });

  if (!response?.ok) {
    return {};
  }

  const resolved = response.data?.resolved ?? {};
  if (Object.keys(resolved).length > 0) {
    const sevenTvPatch = {};
    for (const [name, entry] of Object.entries(resolved)) {
      const url = typeof entry === 'string' ? entry : entry?.url;
      if (!url) {
        continue;
      }

      sevenTvPatch[name] = url;
      const id = typeof entry === 'object' ? entry?.id : extractSevenTvIdFromUrl(url);
      if (id) {
        registerEmoteEntry('7tv', id, entry?.name ?? name, url);
      }
    }

    state.emotes.sevenTv = mergeEmotesFirstWins(state.emotes.sevenTv, sevenTvPatch);
  }

  return resolved;
}

async function resolveMissingEmotes(container) {
  if (!container) {
    return;
  }

  if (resolveEmotesInFlight) {
    resolveEmotesPending = true;
    return;
  }

  const unknown = collectUnknownEmoteTokens(container);
  if (unknown.size === 0) {
    return;
  }

  resolveEmotesInFlight = true;
  try {
    await resolveEmoteNames([...unknown]);

    const emoteMap = getCombinedEmoteMap();
    for (const element of container.querySelectorAll('.wp-chat-text')) {
      clearStaleChatTextMetadata(element);

      if (!messageHasUnrenderedEmotes(element, emoteMap)) {
        continue;
      }

      resetChatTextElement(element);
      processChatTextElement(element, emoteMap);
    }
  } finally {
    resolveEmotesInFlight = false;

    if (resolveEmotesPending) {
      resolveEmotesPending = false;
      scheduleResolveMissingEmotes(container);
    }
  }
}

function scheduleResolveMissingEmotes(container) {
  if (!container) return;
  clearTimeout(resolveEmotesTimer);
  resolveEmotesTimer = setTimeout(() => {
    resolveMissingEmotes(container);
  }, 400);
}

function scheduleRenderEmotes(container) {
  if (!container) return;
  clearTimeout(renderEmotesTimer);
  renderEmotesTimer = setTimeout(() => {
    renderEmotesInContainer(container);
  }, 16);
}

function renderEmotesInContainer(container) {
  if (!container) return;

  const emoteMap = getCombinedEmoteMap();
  const messageTexts = container.querySelectorAll('.wp-chat-text');
  if (messageTexts.length === 0) {
    processMessageElement(container, emoteMap);
  } else {
    for (const node of messageTexts) {
      processChatTextElement(node, emoteMap);
    }
  }

  scheduleResolveMissingEmotes(container);
}

function processChatTextElement(element, emoteMap) {
  if (!(element instanceof HTMLElement)) {
    return;
  }

  clearStaleChatTextMetadata(element);

  if (element.querySelector('[data-reyohoho-emote-processed]')) {
    if (messageHasUnrenderedEmotes(element, emoteMap)) {
      resetChatTextElement(element);
    } else if (!hasUnprocessedTextInElement(element)) {
      return;
    }
  }

  const sourceText = getChatTextSourceText(element);
  if (!sourceText.trim() || !textHasRenderableEmotes(sourceText, emoteMap)) {
    return;
  }

  preregisterEmotesFromMetadata(sourceText);

  const html = renderEmotesInText(sourceText, emoteMap);
  if (html === escapeHtml(sourceText)) {
    return;
  }

  element.dataset.reyohohoSourceText = sourceText;

  const wrapper = document.createElement('span');
  wrapper.dataset.reyohohoEmoteProcessed = 'true';
  wrapper.dataset.reyohohoSourceText = sourceText;
  wrapper.innerHTML = html;
  element.replaceChildren(wrapper);
}

function processTextNode(textNode, emoteMap) {
  const text = textNode.textContent ?? '';
  if (!text.trim() || !textHasRenderableEmotes(text, emoteMap)) {
    return;
  }

  const html = renderEmotesInText(text, emoteMap);
  if (html === escapeHtml(text)) {
    return;
  }

  const wrapper = document.createElement('span');
  wrapper.dataset.reyohohoEmoteProcessed = 'true';
  wrapper.dataset.reyohohoSourceText = text;
  wrapper.innerHTML = html;

  const chatText = textNode.parentElement?.closest('.wp-chat-text');
  if (chatText instanceof HTMLElement) {
    chatText.dataset.reyohohoSourceText = text;
  }

  textNode.replaceWith(wrapper);
}

function processMessageElement(element, emoteMap) {
  if (shouldSkipElement(element)) {
    return;
  }

  if (element.querySelector('[data-reyohoho-emote-processed]')) {
    if (messageHasUnrenderedEmotes(element, emoteMap)) {
      resetChatTextElement(element);
    } else if (!hasUnprocessedTextInElement(element)) {
      return;
    }
  }

  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const textNodes = [];

  while (walker.nextNode()) {
    textNodes.push(walker.currentNode);
  }

  for (const textNode of textNodes) {
    if (textNode.parentElement && !shouldSkipElement(textNode.parentElement)) {
      processTextNode(textNode, emoteMap);
    }
  }
}

async function loadEmotes(forceRefresh = false) {
  const response = await sendRuntimeMessage({ type: 'GET_EMOTES', forceRefresh });
  if (!response?.ok) {
    console.warn('[ReYohoho Chat] Failed to load emotes:', response?.error);
    return;
  }

  state.emotes = {
    sevenTv: response.data.sevenTv ?? {},
  };

  registerEmoteMap('7tv', state.emotes.sevenTv, extractSevenTvIdFromUrl);

  renderEmotesInContainer(state.chatMessages);
}

async function loadHistory() {
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  state.history = Array.isArray(stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];
}

async function saveHistoryEntry(message) {
  const trimmed = message.trim();
  if (!trimmed) return;

  state.history = [...state.history.filter((entry) => entry !== trimmed), trimmed];
  if (state.history.length > MAX_HISTORY) {
    state.history = state.history.slice(-MAX_HISTORY);
  }

  await chrome.storage.local.set({ [HISTORY_KEY]: state.history });
  state.historyIndex = -1;
  state.draftBeforeHistory = '';
}

function setInputValue(input, value) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function handleHistoryNavigation(event) {
  if (!state.chatInput || state.history.length === 0) {
    return;
  }

  if (event.key === 'ArrowUp') {
    if (state.historyIndex === -1) {
      state.draftBeforeHistory = state.chatInput.value;
      state.historyIndex = state.history.length - 1;
    } else if (state.historyIndex > 0) {
      state.historyIndex -= 1;
    } else {
      return;
    }

    event.preventDefault();
    setInputValue(state.chatInput, state.history[state.historyIndex]);
    return;
  }

  if (event.key === 'ArrowDown' && state.historyIndex !== -1) {
    event.preventDefault();

    if (state.historyIndex < state.history.length - 1) {
      state.historyIndex += 1;
      setInputValue(state.chatInput, state.history[state.historyIndex]);
      return;
    }

    state.historyIndex = -1;
    setInputValue(state.chatInput, state.draftBeforeHistory);
  }
}

function captureOutgoingMessage() {
  if (!state.chatInput) return;
  const value = stripEmoteMetadata(state.chatInput.value.trim());
  if (!value) return;
  saveHistoryEntry(value);
}

function clearComposePreview() {
  state.composeSelections.clear();
  state.composePreview = null;
  updateComposePreviewHint();
}

function updateComposePreviewHint() {
  const hint = state.composePreviewHint;
  if (!hint) {
    return;
  }

  const preview = state.composePreview;
  const candidate = preview?.candidates?.[preview.selectedIndex];
  if (!candidate?.name) {
    hint.hidden = true;
    hint.textContent = '';
    return;
  }

  const total = preview.candidates.length;
  hint.textContent =
    total > 1 ? `${candidate.name} (${preview.selectedIndex + 1}/${total})` : candidate.name;
  hint.hidden = false;
}

function ensureComposePreviewHint() {
  if (state.composePreviewHint || !state.inputShell) {
    return;
  }

  const hint = document.createElement('div');
  hint.className = 'reyohoho-compose-preview-hint';
  hint.hidden = true;
  state.inputShell.append(hint);
  state.composePreviewHint = hint;
}

function applyComposeMetadata(value) {
  if (state.composeSelections.size === 0) {
    return value;
  }

  const selections = [...state.composeSelections.values()].sort((a, b) => b.end - a.end);
  let result = value;

  for (const selection of selections) {
    const candidate = selection.candidates[selection.selectedIndex];
    if (!candidate || selection.selectedIndex === 0) {
      continue;
    }

    if (result.slice(selection.start, selection.end).toLowerCase() !== selection.query.toLowerCase()) {
      continue;
    }

    if (parseEmoteMetaSuffix(result, selection.end)) {
      continue;
    }

    const meta = buildEmoteMeta(candidate.provider, candidate.id, candidate.name);
    result = result.slice(0, selection.end) + meta + result.slice(selection.end);
  }

  return result;
}

function injectMetadataBeforeSend() {
  const input = state.chatInput;
  if (!input) {
    return;
  }

  const next = applyComposeMetadata(input.value);
  if (next !== input.value) {
    setInputValue(input, next);
  }
}

function renderComposeMirror(value, preview) {
  const mirror = state.inputMirror;
  if (!mirror || !preview) {
    return;
  }

  const candidate = preview.candidates[preview.selectedIndex];
  if (!candidate) {
    updateInputMirrorPlainText();
    return;
  }

  const before = value.slice(0, preview.start);
  const after = value.slice(preview.end);
  const total = preview.candidates.length;
  const position = preview.selectedIndex + 1;
  const title = total > 1 ? `${candidate.name} (${position}/${total})` : candidate.name;

  mirror.innerHTML =
    `${escapeHtml(before)}<span class="reyohoho-emote-wrap reyohoho-compose-emote-wrap" data-emote-name="${escapeHtml(candidate.name)}" data-emote-provider="${escapeHtml(candidate.provider)}" data-emote-id="${escapeHtml(candidate.id)}" title="${escapeHtml(title)}"><img class="reyohoho-emote reyohoho-compose-emote" src="${candidate.url}" alt="${escapeHtml(candidate.name)}"></span>${escapeHtml(after)}` ||
    '&nbsp;';

  syncInputMirrorScroll();
  updateComposePreviewHint();
}

function syncInputMirrorScroll() {
  if (!state.chatInput || !state.inputMirror) {
    return;
  }

  state.inputMirror.scrollLeft = state.chatInput.scrollLeft;
}

function getTokenBoundsBeforeCursor(value, cursorPos) {
  const leftPart = value.slice(0, cursorPos);
  const spaceIndex = leftPart.lastIndexOf(' ');
  const start = spaceIndex + 1;
  const token = value.slice(start, cursorPos);

  return { start, end: cursorPos, token };
}

function parseEmoteToken(rawToken) {
  const stripped = stripTokenEdges(rawToken);
  if (!stripped || stripped.length < MIN_EMOTE_LOOKUP_LENGTH) {
    return null;
  }
  if (/^\d+$/.test(stripped)) {
    return null;
  }

  if (isEnglishWord(stripped)) {
    return stripped;
  }

  const englishWords = [...stripped.matchAll(/[A-Za-z]{2,}/g)];
  if (englishWords.length > 0) {
    return englishWords.at(-1)[0];
  }

  return stripped;
}

function updateInputMirrorPlainText() {
  const input = state.chatInput;
  const mirror = state.inputMirror;
  if (!input || !mirror) {
    return;
  }

  const text = input.value;
  mirror.innerHTML = text ? escapeHtml(text) : '&nbsp;';
  syncInputMirrorScroll();
}

function hookInputValueSync(input) {
  if (!input || input.dataset.reyohohoValueHook === 'true') {
    return;
  }

  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  if (!descriptor?.set || !descriptor?.get) {
    return;
  }

  const nativeSet = descriptor.set;
  const nativeGet = descriptor.get;

  Object.defineProperty(input, 'value', {
    configurable: true,
    enumerable: true,
    get() {
      return nativeGet.call(this);
    },
    set(next) {
      nativeSet.call(this, next);
      if (this === state.chatInput) {
        updateInputMirrorPlainText();
      }
    },
  });

  input.dataset.reyohohoValueHook = 'true';
}

function syncInputMirrorAfterSend() {
  const run = () => updateInputMirrorPlainText();
  run();
  queueMicrotask(run);
  requestAnimationFrame(run);
  for (const delay of [0, 16, 50, 100, 200]) {
    setTimeout(run, delay);
  }
}

async function onMessageSend() {
  injectMetadataBeforeSend();
  queueMicrotask(captureOutgoingMessage);
  syncInputMirrorAfterSend();
  clearComposePreview();

  const text = stripEmoteMetadata(state.chatInput?.value?.trim() ?? '');
  if (!text) {
    return;
  }

  const unknown = collectUnknownEmoteTokensFromText(text);
  if (unknown.size > 0) {
    await resolveEmoteNames([...unknown]);
    if (state.chatMessages) {
      renderEmotesInContainer(state.chatMessages);
    }
  }

  onActivity();
}

async function handleTabEmotePreview(event) {
  if (event.key !== 'Tab' || event.ctrlKey || event.altKey || event.metaKey) {
    return;
  }

  const input = state.chatInput;
  if (!input || !state.inputMirror) {
    return;
  }

  const cursor = input.selectionStart ?? input.value.length;
  const { start, end, token } = getTokenBoundsBeforeCursor(input.value, cursor);
  const emoteCode = parseEmoteToken(token);

  if (!emoteCode) {
    return;
  }

  event.preventDefault();

  const shift = event.shiftKey;
  const key = `${start}:${end}`;
  let selection = state.composeSelections.get(key);

  if (!selection || selection.query !== emoteCode) {
    let candidates = await searchEmoteCandidates(emoteCode);

    if (candidates.length === 0) {
      let url = lookupEmoteUrl(getCombinedEmoteMap(), emoteCode);
      if (!url) {
        const resolved = await resolveEmoteNames([emoteCode]);
        const entry = resolved[emoteCode];
        url = typeof entry === 'string' ? entry : entry?.url;
      }

      if (url) {
        const id = extractSevenTvIdFromUrl(url);
        if (id) {
          candidates = [{ provider: '7tv', id, name: emoteCode, url }];
          registerEmoteCandidates(candidates);
        }
      }
    }

    if (candidates.length === 0) {
      clearComposePreview();
      updateInputMirrorPlainText();
      return;
    }

    selection = {
      key,
      start,
      end,
      query: emoteCode,
      candidates,
      selectedIndex: 0,
    };
    state.composeSelections.set(key, selection);
  } else if (shift) {
    selection.selectedIndex =
      (selection.selectedIndex - 1 + selection.candidates.length) % selection.candidates.length;
  } else {
    selection.selectedIndex = (selection.selectedIndex + 1) % selection.candidates.length;
  }

  state.composePreview = selection;
  renderComposeMirror(input.value, selection);
  onActivity();
}

function setupInputPreview() {
  const input = state.chatInput;
  if (!input || input.dataset.reyohohoPreview === 'true') {
    return;
  }

  let shell = state.inputShell ?? input.closest('.reyohoho-input-shell');
  let mirror = state.inputMirror ?? shell?.querySelector('.reyohoho-input-mirror');

  if (!shell || !mirror) {
    const wrapper = input.closest('.wp-chat-input-wrapper');
    if (!wrapper) {
      return;
    }

    shell = document.createElement('div');
    shell.className = 'reyohoho-input-shell';

    mirror = document.createElement('div');
    mirror.className = 'reyohoho-input-mirror';
    mirror.setAttribute('aria-hidden', 'true');

    input.parentElement?.insertBefore(shell, input);
    shell.append(mirror, input);
  }

  input.classList.add('reyohoho-input-mirror-field');
  input.dataset.reyohohoPreview = 'true';
  state.inputMirror = mirror;
  state.inputShell = shell;
  ensureComposePreviewHint();
  hookInputValueSync(input);
  wireInputPreviewListeners(input);
  updateInputMirrorPlainText();
}

function wireInputPreviewListeners(input) {
  if (input.dataset.reyohohoPreviewWire === 'true') {
    return;
  }

  input.dataset.reyohohoPreviewWire = 'true';

  input.addEventListener('input', () => {
    if (state.suppressInputEvents) {
      updateInputMirrorPlainText();
      return;
    }

    clearComposePreview();
    updateInputMirrorPlainText();
    onActivity();
  });
  input.addEventListener('scroll', syncInputMirrorScroll);
  input.addEventListener('keydown', handleTabEmotePreview);
  input.addEventListener('blur', updateInputMirrorPlainText);
}

function bindInputHandlers(onSendPrepared) {
  if (!state.chatInput || state.chatInput.dataset.reyohohoInputBound === 'true') {
    return;
  }

  state.chatInput.dataset.reyohohoInputBound = 'true';

  state.chatInput.addEventListener('keydown', handleHistoryNavigation);

  state.chatInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      if (onSendPrepared) {
        handlePopoutSendLocal(event);
      } else {
        onMessageSend();
      }
    }
  }, true);
}

function bindSendHandlers(onSendPrepared) {
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
}


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
      }

      bindInputHandlers(onSendPrepared);
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
