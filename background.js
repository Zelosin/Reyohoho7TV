const SEVENTV_FALLBACK_URL = chrome.runtime.getURL('src/data/seventv-emotes-fallback.json');

const EMOTE_CACHE_KEY = 'emoteCache';
const RESOLVED_7TV_KEY = 'resolved7tvEmotesV2';
const RESOLVED_7TV_IDS_KEY = 'resolved7tvEmoteIdsV1';
const FAILED_7TV_KEY = 'failed7tvEmotes';
const EMOTE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FAILED_7TV_TTL_MS = 60 * 60 * 1000;
const SEVENTV_SEARCH_QUERY = `query SearchEmotes($query: String!) {
  emotes(
    query: $query
    page: 1
    limit: 100
    filter: { exact_match: false case_sensitive: false }
    sort: { value: "popularity" order: DESCENDING }
  ) {
    items { id name host { url files { name } } }
  }
}`;

let popoutWindowId = null;

/** @type {Map<number, { hostPort?: chrome.runtime.Port, popoutPort?: chrome.runtime.Port }>} */
const popoutBridges = new Map();

/** @type {Map<number, { payload: unknown }>} */
const latestPopoutSync = new Map();

function getPopoutBridge(hostTabId) {
  if (!popoutBridges.has(hostTabId)) {
    popoutBridges.set(hostTabId, {});
  }
  return popoutBridges.get(hostTabId);
}

function relayToPopout(hostTabId, message) {
  getPopoutBridge(hostTabId).popoutPort?.postMessage(message);
}

function deliverPopoutSync(hostTabId, payload) {
  latestPopoutSync.set(hostTabId, { payload });
  relayToPopout(hostTabId, { type: 'SYNC', payload });
}

function schedulePopoutSyncDelivery(hostTabId, port) {
  const deliver = () => {
    const bridge = getPopoutBridge(hostTabId);
    if (bridge.popoutPort !== port) {
      return;
    }

    const pending = latestPopoutSync.get(hostTabId);
    if (pending?.payload) {
      port.postMessage({ type: 'SYNC', payload: pending.payload });
    }
  };

  for (const delay of [0, 50, 150, 400, 800]) {
    if (delay === 0) {
      queueMicrotask(deliver);
    } else {
      setTimeout(deliver, delay);
    }
  }
}

function relayToHost(hostTabId, message) {
  getPopoutBridge(hostTabId).hostPort?.postMessage(message);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'reyohoho-popout-host') {
    const hostTabId = port.sender?.tab?.id;
    if (hostTabId == null) {
      return;
    }

    const bridge = getPopoutBridge(hostTabId);
    bridge.hostPort = port;

    port.onMessage.addListener((message) => {
      if (message.type === 'SYNC_TO_POPOUT') {
        deliverPopoutSync(hostTabId, message.payload);
      }
    });

    port.onDisconnect.addListener(() => {
      if (bridge.hostPort === port) {
        bridge.hostPort = undefined;
      }
      relayToPopout(hostTabId, { type: 'HOST_DISCONNECTED' });
    });

    if (bridge.popoutPort) {
      port.postMessage({ type: 'POPOUT_CONNECTED' });
      schedulePopoutSyncDelivery(hostTabId, bridge.popoutPort);
    }

    return;
  }

  const popoutMatch = port.name.match(/^reyohoho-popout-window:(\d+)$/);
  if (popoutMatch) {
    const hostTabId = Number(popoutMatch[1]);
    const bridge = getPopoutBridge(hostTabId);
    bridge.popoutPort = port;

    port.onMessage.addListener((message) => {
      if (message.type === 'REQUEST_SYNC') {
        schedulePopoutSyncDelivery(hostTabId, port);
        relayToHost(hostTabId, { type: 'REQUEST_SYNC' });
        return;
      }

      relayToHost(hostTabId, message);
    });

    port.onDisconnect.addListener(() => {
      if (bridge.popoutPort === port) {
        bridge.popoutPort = undefined;
        relayToHost(hostTabId, { type: 'POPOUT_DISCONNECTED' });
      }
    });

    relayToHost(hostTabId, { type: 'POPOUT_CONNECTED' });
    schedulePopoutSyncDelivery(hostTabId, port);
  }
});

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

function pickSevenTvEmoteUrl(entry) {
  const id = entry.id ?? entry.data?.id;
  const host = entry.host ?? entry.data?.host ?? {};
  const files = host.files ?? [];

  const preferred = files.find((file) => file.name === '2x.webp' || file.name === '2x')
    ?? files.find((file) => file.name === '3x.webp' || file.name === '3x')
    ?? files[0];

  if (preferred && host.url) {
    const base = host.url.startsWith('//') ? `https:${host.url}` : host.url;
    return `${base}/${preferred.name}`;
  }

  if (host.url) {
    const base = host.url.startsWith('//') ? `https:${host.url}` : host.url;
    return `${base}/2x.webp`;
  }

  return `https://cdn.7tv.app/emote/${id}/2x.webp`;
}

/** Порядок из API сохраняется; при дубликате имени остаётся первый. */
async function fetchSevenTvGlobalEmotes() {
  const response = await fetch('https://7tv.io/v3/emote-sets/global', {
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`7TV emotes request failed: ${response.status}`);
  }

  const data = await response.json();
  const map = {};

  for (const entry of data.emotes ?? []) {
    const name = entry.name ?? entry.data?.name;
    if (!name || Object.prototype.hasOwnProperty.call(map, name)) {
      continue;
    }

    map[name] = pickSevenTvEmoteUrl(entry);
  }

  return map;
}

async function loadSevenTvEmotesDynamic() {
  let map;
  try {
    map = await fetchSevenTvGlobalEmotes();
  } catch (error) {
    console.warn('[ReYohoho Chat] 7TV live fetch failed, using fallback.', error);
    map = await loadFallbackJson(SEVENTV_FALLBACK_URL);
  }

  const stored = await chrome.storage.local.get([RESOLVED_7TV_KEY]);
  return mergeEmotesFirstWins(map, stored[RESOLVED_7TV_KEY] ?? {});
}

function extractSevenTvIdFromUrl(url) {
  const match = String(url).match(/\/emote\/([A-Za-z0-9]+)\//);
  return match?.[1] ?? null;
}

function filterSevenTvSearchMatches(items, query) {
  const lower = query.toLowerCase();
  const exact = [];
  const insensitive = [];

  for (const item of items) {
    if (item.name === query) {
      exact.push(item);
    } else if (item.name.toLowerCase() === lower) {
      insensitive.push(item);
    }
  }

  return [...exact, ...insensitive];
}

async function searchSevenTvEmoteItems(query) {
  const response = await fetch('https://7tv.io/v3/gql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({
      query: SEVENTV_SEARCH_QUERY,
      variables: { query },
    }),
  });

  if (!response.ok) {
    throw new Error(`7TV search failed: ${response.status}`);
  }

  const data = await response.json();
  if (data.errors?.length) {
    throw new Error(data.errors[0].message);
  }

  return data.data?.emotes?.items ?? [];
}

/**
 * API возвращает items, отсортированные по popularity DESC.
 * Среди совпадений по имени выбираем самый популярный — первый в этом списке.
 */
function pickMostPopularSevenTvSearchMatch(items, query) {
  return filterSevenTvSearchMatches(items, query)[0] ?? null;
}

async function searchSevenTvEmote(query) {
  const items = await searchSevenTvEmoteItems(query);
  return pickMostPopularSevenTvSearchMatch(items, query);
}

async function getCachedSevenTvMap() {
  const cached = await chrome.storage.local.get([EMOTE_CACHE_KEY]);
  const payload = cached[EMOTE_CACHE_KEY] ?? {};
  return payload.sevenTv ?? {};
}

async function searchEmoteCandidates(query) {
  const name = query?.trim();
  if (!name) {
    return [];
  }

  const sevenTv = await getCachedSevenTvMap();
  const seen = new Set();
  const candidates = [];

  const addCandidate = (provider, id, emoteName, url) => {
    if (!id || !url) {
      return;
    }

    const key = `${provider}:${id}`;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    candidates.push({ provider, id: String(id), name: emoteName, url });
  };

  try {
    const items = await searchSevenTvEmoteItems(name);
    for (const item of filterSevenTvSearchMatches(items, name)) {
      addCandidate('7tv', item.id, item.name, pickSevenTvEmoteUrl(item));
    }
  } catch (error) {
    console.warn(`[ReYohoho Chat] 7TV candidate search for "${name}" failed:`, error);
  }

  const lower = name.toLowerCase();
  for (const [emoteName, url] of Object.entries(sevenTv)) {
    if (emoteName === name || emoteName.toLowerCase() === lower) {
      addCandidate('7tv', extractSevenTvIdFromUrl(url), emoteName, url);
    }
  }

  return candidates;
}

async function loadFailed7tv() {
  const stored = await chrome.storage.local.get([FAILED_7TV_KEY]);
  return stored[FAILED_7TV_KEY] ?? {};
}

async function resolveSevenTvEmoteNames(names) {
  const resolved = (await chrome.storage.local.get([RESOLVED_7TV_KEY]))[RESOLVED_7TV_KEY] ?? {};
  const resolvedIds =
    (await chrome.storage.local.get([RESOLVED_7TV_IDS_KEY]))[RESOLVED_7TV_IDS_KEY] ?? {};
  const failed = await loadFailed7tv();
  const now = Date.now();
  const added = {};

  for (const rawName of names) {
    const name = rawName?.trim();
    if (!name || added[name]) {
      continue;
    }

    if (resolved[name]) {
      added[name] = {
        url: resolved[name],
        id: resolvedIds[name] ?? extractSevenTvIdFromUrl(resolved[name]),
      };
      continue;
    }

    const failedAt = failed[name];
    if (failedAt && now - failedAt < FAILED_7TV_TTL_MS) {
      continue;
    }

    try {
      const item = await searchSevenTvEmote(name);
      if (!item) {
        failed[name] = now;
        continue;
      }

      const url = pickSevenTvEmoteUrl(item);
      const emoteId = String(item.id);
      const resolvedKey = item.name ?? name;
      resolved[name] = url;
      resolvedIds[name] = emoteId;
      if (resolvedKey !== name) {
        resolved[resolvedKey] = url;
      }
      added[name] = { url, id: emoteId, name: resolvedKey };
      delete failed[name];
    } catch (error) {
      console.warn(`[ReYohoho Chat] 7TV search for "${name}" failed:`, error);
      failed[name] = now;
    }
  }

  await chrome.storage.local.set({
    [RESOLVED_7TV_KEY]: resolved,
    [RESOLVED_7TV_IDS_KEY]: resolvedIds,
    [FAILED_7TV_KEY]: failed,
  });

  return added;
}

async function loadFallbackJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Fallback emotes failed: ${url}`);
  }
  return response.json();
}

async function buildEmoteCache(forceRefresh = false) {
  const cached = await chrome.storage.local.get([EMOTE_CACHE_KEY]);
  const existing = cached[EMOTE_CACHE_KEY];
  const cacheValid =
    existing?.sevenTvUpdatedAt &&
    !forceRefresh &&
    Date.now() - existing.sevenTvUpdatedAt < EMOTE_CACHE_TTL_MS;

  const sevenTv = cacheValid ? existing.sevenTv : await loadSevenTvEmotesDynamic();

  const payload = {
    updatedAt: Date.now(),
    sevenTv,
    sevenTvUpdatedAt: Date.now(),
  };

  await chrome.storage.local.set({ [EMOTE_CACHE_KEY]: payload });
  return payload;
}

async function focusOrCreatePopout({ hostTabId, width, height, left, top }) {
  const url = `${chrome.runtime.getURL('chat-popout.html')}?hostTabId=${hostTabId}`;

  if (popoutWindowId !== null) {
    try {
      const existing = await chrome.windows.get(popoutWindowId, { populate: true });
      const bridge = getPopoutBridge(hostTabId);
      const popoutTab = existing.tabs?.[0];

      if (existing && bridge.popoutPort) {
        await chrome.windows.update(popoutWindowId, { focused: true });
        relayToHost(hostTabId, { type: 'POPOUT_CONNECTED' });
        schedulePopoutSyncDelivery(hostTabId, bridge.popoutPort);
        return { windowId: popoutWindowId, reused: true };
      }

      if (existing && popoutTab?.id) {
        await chrome.tabs.update(popoutTab.id, { url, active: true });
        await chrome.windows.update(popoutWindowId, { focused: true });
        return { windowId: popoutWindowId, reused: true, reloaded: true };
      }
    } catch {
      popoutWindowId = null;
    }
  }

  if (popoutWindowId !== null) {
    try {
      await chrome.windows.remove(popoutWindowId);
    } catch {
      // Window already closed.
    }
    popoutWindowId = null;
  }

  const created = await chrome.windows.create({
    url,
    type: 'popup',
    width: width ?? 420,
    height: height ?? 820,
    left,
    top,
    focused: true,
  });

  popoutWindowId = created.id ?? null;
  return { windowId: popoutWindowId, reused: false };
}

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === popoutWindowId) {
    popoutWindowId = null;
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case 'GET_EMOTES':
        sendResponse({ ok: true, data: await buildEmoteCache(Boolean(message.forceRefresh)) });
        break;
      case 'RESOLVE_7TV_EMOTES':
        sendResponse({
          ok: true,
          data: { resolved: await resolveSevenTvEmoteNames(message.names ?? []) },
        });
        break;
      case 'SEARCH_EMOTE_CANDIDATES':
        sendResponse({
          ok: true,
          data: { candidates: await searchEmoteCandidates(message.query ?? '') },
        });
        break;
      case 'OPEN_POPOUT': {
        const hostTabId = sender.tab?.id;
        if (hostTabId == null) {
          sendResponse({ ok: false, error: 'Host tab unavailable' });
          break;
        }

        sendResponse({
          ok: true,
          data: await focusOrCreatePopout({
            hostTabId,
            width: message.width,
            height: message.height,
            left: message.left,
            top: message.top,
          }),
        });
        break;
      }
      case 'POPOUT_CLOSED':
        if (message.windowId === popoutWindowId) {
          popoutWindowId = null;
        }
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ ok: false, error: 'Unknown message type' });
    }
  })().catch((error) => {
    sendResponse({ ok: false, error: String(error) });
  });

  return true;
});

buildEmoteCache().catch((error) => {
  console.warn('[ReYohoho Chat] Initial emote cache warmup failed.', error);
});
