const { spawn } = require('child_process');
const axios = require('axios');
const WebSocket = require('ws');

const API_PREFIX = '/api/v1';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForReady(apiUrl, timeout = 30000, interval = 1000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await axios.get(apiUrl, { timeout: 3000 });
      if (res.status === 200) return true;
    } catch (e) {
      // ignore and retry
    }
    await sleep(interval);
  }
  throw new Error(`Suwayomi did not become ready at ${apiUrl} within ${timeout}ms`);
}

function startSuwayomiJar(jarPath, options = {}) {
  const javaBin = options.java || 'java';
  // Build -D overrides from configOverrides (flat object)
  const configArgs = [];

  function toConfigOverrideValue(v) {
    if (Array.isArray(v)) {
      const quoted = v.map(item => `"${String(item).replace(/\\/g, '/').replace(/"/g, '\\"')}"`);
      return `[${quoted.join(',')}]`;
    }
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (v == null) return '';
    return String(v);
  }

  if (options.configOverrides && typeof options.configOverrides === 'object') {
    for (const [k, v] of Object.entries(options.configOverrides)) {
      const key = `-Dsuwayomi.tachidesk.config.${k}=${toConfigOverrideValue(v)}`;
      configArgs.push(key);
    }
  }
  const args = configArgs.concat(options.javaArgs || [], ['-jar', jarPath]);
  const proc = spawn(javaBin, args, {
    cwd: options.cwd || process.cwd(),
    stdio: options.stdio || 'ignore',
    detached: !!options.detached
  });

  if (!options.detached) {
    proc.unref && proc.unref();
  }

  return {
    proc,
    stop: () => {
      try { proc.kill(); } catch (e) { /* ignore */ }
    }
  };
}

function startKomgaJar(jarPath, options = {}) {
  const javaBin = options.java || 'java';
  const args = (options.javaArgs || []).concat(['-jar', jarPath], options.appArgs || []);
  const proc = spawn(javaBin, args, {
    cwd: options.cwd || process.cwd(),
    stdio: options.stdio || 'ignore',
    detached: !!options.detached,
    env: options.env || process.env
  });

  if (!options.detached) {
    proc.unref && proc.unref();
  }

  return {
    proc,
    stop: () => {
      try { proc.kill(); } catch (e) { /* ignore */ }
    }
  };
}

function makeApiClient(baseUrl, defaultOpts = {}) {
  const client = axios.create(Object.assign({ baseURL: baseUrl, timeout: 10000 }, defaultOpts));

  async function request(method, path, opts = {}) {
    const cfg = Object.assign({}, opts, { method, url: path });
    return client.request(cfg).then(r => r.data);
  }

  async function requestRaw(method, path, opts = {}) {
    const cfg = Object.assign({}, opts, { method, url: path });
    return client.request(cfg);
  }

  return {
    get: (path, params) => request('get', path, { params }),
    post: (path, data) => request('post', path, { data }),
    request,
    requestRaw
  };
}

function quotePathForHocon(v) {
  return String(v || '').replace(/\\/g, '/');
}

async function listExtensions(apiClient) {
  return apiClient.get(`${API_PREFIX}/extension/list`);
}

async function installExtension(apiClient, pkgName) {
  return apiClient.requestRaw('get', `${API_PREFIX}/extension/install/${encodeURIComponent(pkgName)}`, {
    validateStatus: () => true
  });
}

async function listSources(apiClient) {
  return apiClient.get(`${API_PREFIX}/source/list`);
}

async function searchSource(apiClient, sourceId, searchTerm, pageNum = 1) {
  return apiClient.get(`${API_PREFIX}/source/${encodeURIComponent(sourceId)}/search`, {
    searchTerm,
    pageNum
  });
}

async function addMangaToLibrary(apiClient, mangaId) {
  return apiClient.get(`${API_PREFIX}/manga/${mangaId}/library`);
}

async function removeMangaFromLibrary(apiClient, mangaId) {
  const id = Number(mangaId);
  if (!Number.isFinite(id)) return false;

  const res = await apiClient.requestRaw('delete', `${API_PREFIX}/manga/${id}/library`, {
    validateStatus: () => true
  });
  const status = Number(res && res.status);
  if (status >= 200 && status < 300) return true;
  if (status === 404) return false;

  throw new Error(`Failed removing manga ${id} from library (HTTP ${status || 'unknown'})`);
}

async function getMangaChapters(apiClient, mangaId, onlineFetch = true) {
  return apiClient.get(`${API_PREFIX}/manga/${mangaId}/chapters`, { onlineFetch });
}

async function queueChapter(apiClient, mangaId, chapterIndex) {
  return apiClient.get(`${API_PREFIX}/download/${mangaId}/chapter/${chapterIndex}`);
}

async function startDownloader(apiClient) {
  return apiClient.get(`${API_PREFIX}/downloads/start`);
}

async function stopDownloader(apiClient) {
  return apiClient.get(`${API_PREFIX}/downloads/stop`);
}

async function deleteDownloadedChapter(apiClient, chapterIndex) {
  const id = Number(chapterIndex);
  if (!Number.isFinite(id)) throw new Error('Invalid chapter index for delete');

  const del = await apiClient.requestRaw('delete', `${API_PREFIX}/chapter/${id}`, {
    validateStatus: () => true
  });
  if (Number(del && del.status) >= 200 && Number(del && del.status) < 400) {
    return true;
  }

  const fallback = await apiClient.requestRaw('get', `${API_PREFIX}/chapter/${id}/delete`, {
    validateStatus: () => true
  });
  if (Number(fallback && fallback.status) >= 200 && Number(fallback && fallback.status) < 400) {
    return true;
  }

  throw new Error(`Failed deleting chapter ${id} (HTTP ${fallback && fallback.status ? fallback.status : 'unknown'})`);
}

async function getDownloadsState(apiClient) {
  return apiClient.get(`${API_PREFIX}/downloads`);
}

function toWebSocketUrl(apiUrl, pathSuffix) {
  const u = new URL(apiUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = pathSuffix;
  u.search = '';
  u.hash = '';
  return u.toString();
}

async function waitForDownloadsToFinish(apiUrl, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 0);
  const idleGraceMs = Number(options.idleGraceMs || 5000);
  const wsUrl = toWebSocketUrl(apiUrl, `${API_PREFIX}/downloads`);

  return new Promise((resolve, reject) => {
    let settled = false;
    let idleTimer = null;
    let timeoutTimer = null;

    const ws = new WebSocket(wsUrl);

    const finish = (err, payload) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      try { ws.close(); } catch (e) { /* ignore */ }
      if (err) reject(err); else resolve(payload || { done: true });
    };

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        finish(new Error(`Timed out waiting for downloads to finish after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    ws.on('message', raw => {
      let payload = null;
      try {
        payload = JSON.parse(String(raw));
      } catch (e) {
        return;
      }

      const queueLen = Array.isArray(payload.queue) ? payload.queue.length : null;
      const stoppedAndEmpty = payload.status === 'Stopped' && queueLen === 0;

      if (stoppedAndEmpty) {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => finish(null, payload), idleGraceMs);
      } else if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    });

    ws.on('error', err => finish(err));
  });
}

async function getDownloadsSnapshot(apiUrl, timeoutMs = 4000) {
  const wsUrl = toWebSocketUrl(apiUrl, `${API_PREFIX}/downloads`);
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch (e) { /* ignore */ }
      reject(new Error(`Timed out waiting for downloads snapshot after ${timeoutMs}ms`));
    }, timeoutMs);

    ws.on('message', raw => {
      if (settled) return;
      let payload = null;
      try {
        payload = JSON.parse(String(raw));
      } catch (e) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch (e) { /* ignore */ }
      resolve(payload);
    });

    ws.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

function normalizeTitleForMatch(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeTitle(s) {
  const stop = new Set(['the', 'a', 'an', 'of', 'to', 'and', 'in', 'on', 'no', 'wa', 'ga', 'de', 'ni']);
  return normalizeTitleForMatch(s)
    .split(' ')
    .map(x => x.trim())
    .filter(Boolean)
    .filter(x => x.length > 1)
    .filter(x => !stop.has(x));
}

function scoreTitleMatch(inputKey, candidateTitle) {
  const a = normalizeTitleForMatch(inputKey);
  const b = normalizeTitleForMatch(candidateTitle);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (b.includes(a) || a.includes(b)) return 92;

  const aTokens = tokenizeTitle(a);
  const bTokens = tokenizeTitle(b);
  if (!aTokens.length || !bTokens.length) return 0;

  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);
  let common = 0;
  for (const t of aSet) if (bSet.has(t)) common += 1;

  const overlapA = common / Math.max(aSet.size, 1);
  const overlapB = common / Math.max(bSet.size, 1);
  const jaccard = common / Math.max(aSet.size + bSet.size - common, 1);
  const headBonus = aTokens[0] && bTokens[0] && aTokens[0] === bTokens[0] ? 8 : 0;
  return Math.min(100, Math.round((overlapA * 55) + (overlapB * 15) + (jaccard * 30) + headBonus));
}

function isStrictTitleMatch(inputKey, candidateTitle, minScore = 88) {
  const score = scoreTitleMatch(inputKey, candidateTitle);
  if (score < minScore) return false;

  const aTokens = tokenizeTitle(inputKey);
  const bTokens = tokenizeTitle(candidateTitle);
  if (!aTokens.length || !bTokens.length) return false;

  const bSet = new Set(bTokens);
  const common = aTokens.filter(t => bSet.has(t));
  if (aTokens.length >= 3) return common.length >= 2;
  return common.length >= 1;
}

function sortSourcesByPriority(sources, sourcePriority = []) {
  if (!Array.isArray(sourcePriority) || sourcePriority.length === 0) return sources;

  const prefs = sourcePriority.map(p => String(p || '').toLowerCase()).filter(Boolean);
  const rank = (s) => {
    const hay = `${s.name || ''} ${s.displayName || ''} ${s.baseUrl || ''} ${s.lang || ''}`.toLowerCase();
    for (let i = 0; i < prefs.length; i += 1) {
      if (hay.includes(prefs[i])) return i;
    }
    return Number.MAX_SAFE_INTEGER;
  };

  return [...sources].sort((a, b) => rank(a) - rank(b));
}

function sourceMatchesAnyPriority(source, sourcePriority = []) {
  const prefs = (sourcePriority || []).map(p => String(p || '').toLowerCase()).filter(Boolean);
  if (!prefs.length) return true;
  const hay = `${source.name || ''} ${source.displayName || ''} ${source.baseUrl || ''} ${source.lang || ''}`.toLowerCase();
  return prefs.some(p => hay.includes(p));
}

function findSourceById(sources, sourceId) {
  const target = String(sourceId || '').trim();
  if (!target || !Array.isArray(sources) || !sources.length) return null;
  return sources.find(s => String(s && s.id).trim() === target) || null;
}

function pickChapterIndexesByNumber(chapters, wantedNumbers) {
  const remaining = chapters
    .filter(ch => Number.isFinite(Number(ch.index)))
    .map(ch => ({
      index: Number(ch.index),
      chapterNumber: Number(ch.chapterNumber),
      downloaded: Boolean(ch.downloaded)
    }));

  const picked = new Set();
  for (const wanted of wantedNumbers) {
    let best = null;
    let bestDelta = Number.POSITIVE_INFINITY;

    for (const ch of remaining) {
      if (picked.has(ch.index)) continue;
      if (ch.downloaded) continue;

      const n = Number(ch.chapterNumber);
      if (Number.isFinite(n)) {
        const delta = Math.abs(n - wanted);
        if (delta < bestDelta) {
          bestDelta = delta;
          best = ch;
        }
      }
    }

    if (best && bestDelta <= 0.51) picked.add(best.index);
  }

  // Fallback when chapter numbers do not align with source numbering.
  if (picked.size === 0) {
    const fallback = remaining.filter(ch => !ch.downloaded).slice(0, wantedNumbers.length);
    fallback.forEach(ch => picked.add(ch.index));
  }

  return [...picked];
}

// High-level helper: search in real Suwayomi source endpoints and enqueue by chapter index.
async function searchAndEnqueue(apiClient, searchKey, chapters = [], sourcePriority = [], options = {}) {
  const allSources = (Array.isArray(options.sources) && options.sources.length)
    ? options.sources
    : await listSources(apiClient);
  if (!Array.isArray(allSources) || allSources.length === 0) {
    throw new Error('No installed sources found. Install at least one extension first.');
  }

  let best = null;
  let searchedSources = 0;
  const sourceErrors = [];
  const suggestionsBySource = [];
  const inputLooksDoujinshi = /doujinshi|dj\b/i.test(String(searchKey || ''));
  const strictTitleMatch = options.strictTitleMatch !== false;
  const strictMinScore = Number(options.strictMinScore || 88);

  if (options.fixedMatch && options.fixedMatch.mangaId != null) {
    const fixedSourceId = options.fixedMatch.sourceId != null ? String(options.fixedMatch.sourceId) : '';
    let fixedSource = findSourceById(allSources, fixedSourceId);
    if (!fixedSource) {
      const fullSources = await listSources(apiClient);
      fixedSource = findSourceById(fullSources, fixedSourceId);
    }
    if (!fixedSource) {
      const err = new Error(`Manual mapping source not found for: ${searchKey} (sourceId=${fixedSourceId})`);
      err.code = 'MAPPING_SOURCE_NOT_FOUND';
      throw err;
    }

    best = {
      source: fixedSource,
      manga: {
        id: Number(options.fixedMatch.mangaId),
        title: options.fixedMatch.mangaTitle || searchKey
      },
      score: 100,
      term: 'manual-link'
    };
    searchedSources = 1;
  } else {
    const prioritized = sortSourcesByPriority(allSources, sourcePriority);
    const prefs = (sourcePriority || []).map(p => String(p || '').trim()).filter(Boolean);
    const preferredOnly = prefs.length ? prioritized.filter(s => sourceMatchesAnyPriority(s, prefs)) : prioritized;
    const fallback = prefs.length ? prioritized.filter(s => !sourceMatchesAnyPriority(s, prefs)) : [];
    const sourceCandidates = preferredOnly.concat(fallback);
    const maxSourcesToTry = Number(options.maxSourcesToTry || sourceCandidates.length || 25);
    const searchTerms = Array.isArray(options.searchTerms) && options.searchTerms.length
      ? options.searchTerms
      : [searchKey];

    for (const source of sourceCandidates.slice(0, maxSourcesToTry)) {
      try {
        searchedSources += 1;
        let sourceSuggestion = null;
        for (const term of searchTerms) {
          const page = await searchSource(apiClient, source.id, term, 1);
          const mangaList = Array.isArray(page && page.mangaList) ? page.mangaList : [];
          if (!sourceSuggestion && mangaList.length) {
            sourceSuggestion = {
              sourceId: String(source.id),
              sourceName: source.name || String(source.id),
              lang: source.lang || '',
              titles: mangaList.slice(0, 5).map(x => x && x.title).filter(Boolean)
            };
          }
          if (!mangaList.length) continue;

          for (const manga of mangaList) {
            const candidateTitle = String((manga && manga.title) || '');
            const candidateLooksDoujinshi = /doujinshi|dj\b/i.test(candidateTitle);
            if (!inputLooksDoujinshi && candidateLooksDoujinshi) {
              continue;
            }

            if (strictTitleMatch && !isStrictTitleMatch(searchKey, candidateTitle, strictMinScore)) {
              continue;
            }

            const score = scoreTitleMatch(searchKey, manga.title);
            if (!best || score > best.score) {
              best = { source, manga, score, term };
            }
          }

          if (best && best.score >= 95) break;
        }

        if (sourceSuggestion) suggestionsBySource.push(sourceSuggestion);

        if (best && best.score >= 95) break;
      } catch (e) {
        sourceErrors.push({ source: source.name || source.id, error: e.message });
      }
    }
  }

  if (!best || !best.manga || !best.manga.id) {
    const suffix = sourceErrors.length
      ? ` | source errors: ${sourceErrors.slice(0, 3).map(x => `${x.source}: ${x.error}`).join(' ; ')}`
      : '';
    const err = new Error(`No matching source found for: ${searchKey} (sources tried: ${searchedSources})${suffix}`);
    err.code = 'NO_MATCH';
    err.details = {
      searchKey,
      searchedSources,
      sourceErrors,
      suggestionsBySource
    };
    throw err;
  }

  const mangaId = Number(best.manga.id);
  await addMangaToLibrary(apiClient, mangaId);
  const chapterList = await getMangaChapters(apiClient, mangaId, true);
  const chapterIndexes = pickChapterIndexesByNumber(chapterList, chapters.map(Number).filter(Number.isFinite));

  if (!chapterIndexes.length) {
    return {
      source: best.source,
      manga: best.manga,
      queuedChapterIndexes: [],
      requestedChapters: chapters,
      searchedSources,
      sourceErrors,
      matchedWithTerm: best.term,
      alreadyQueuedOrDownloaded: true
    };
  }

  for (const chapterIndex of chapterIndexes) {
    await queueChapter(apiClient, mangaId, chapterIndex);
  }
  await startDownloader(apiClient);

  return {
    source: best.source,
    manga: best.manga,
    queuedChapterIndexes: chapterIndexes,
    requestedChapters: chapters,
    searchedSources,
    sourceErrors,
    matchedWithTerm: best.term
  };
}

module.exports = {
  startSuwayomiJar,
  startKomgaJar,
  waitForReady,
  makeApiClient,
  quotePathForHocon,
  listExtensions,
  installExtension,
  listSources,
  searchSource,
  addMangaToLibrary,
  removeMangaFromLibrary,
  getMangaChapters,
  queueChapter,
  startDownloader,
  stopDownloader,
  deleteDownloadedChapter,
  getDownloadsState,
  getDownloadsSnapshot,
  waitForDownloadsToFinish,
  searchAndEnqueue
};
