/**
 * Suwayomi API client.
 *
 * Thin wrapper around axios that maps all Suwayomi v1 REST endpoints
 * used by the pipeline (extensions, sources, manga, chapters, downloads).
 */
const axios = require('axios');
const WebSocket = require('ws');

const API_PREFIX = '/api/v1';

/**
 * Preconfigured axios instance with convenience helpers.
 */
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
    requestRaw,
    instance: client
  };
}

// ---- Endpoints -----------------------------------------------------------

async function listExtensions(api) { return api.get(`${API_PREFIX}/extension/list`); }

async function installExtension(api, pkgName) {
  return api.requestRaw('get', `${API_PREFIX}/extension/install/${encodeURIComponent(pkgName)}`, {
    validateStatus: () => true
  });
}

async function listSources(api) { return api.get(`${API_PREFIX}/source/list`); }

async function searchSource(api, sourceId, searchTerm, pageNum = 1) {
  return api.get(`${API_PREFIX}/source/${encodeURIComponent(sourceId)}/search`, { searchTerm, pageNum });
}

async function addMangaToLibrary(api, mangaId) { return api.get(`${API_PREFIX}/manga/${mangaId}/library`); }

async function removeMangaFromLibrary(api, mangaId) {
  const id = Number(mangaId);
  if (!Number.isFinite(id)) return false;
  const res = await api.requestRaw('delete', `${API_PREFIX}/manga/${id}/library`, { validateStatus: () => true });
  const status = Number(res && res.status);
  if (status >= 200 && status < 300) return true;
  if (status === 404) return false;
  throw new Error(`Failed removing manga ${id} from library (HTTP ${status || 'unknown'})`);
}

async function getMangaChapters(api, mangaId, onlineFetch = true) {
  return api.get(`${API_PREFIX}/manga/${mangaId}/chapters`, { onlineFetch });
}

async function getMangaInfo(api, mangaId) { return api.get(`${API_PREFIX}/manga/${mangaId}`); }

async function queueChapter(api, mangaId, chapterIndex) {
  return api.get(`${API_PREFIX}/download/${mangaId}/chapter/${chapterIndex}`);
}

async function startDownloader(api) { return api.get(`${API_PREFIX}/downloads/start`); }
async function stopDownloader(api) { return api.get(`${API_PREFIX}/downloads/stop`); }

async function deleteDownloadedChapter(api, chapterIndex) {
  const id = Number(chapterIndex);
  if (!Number.isFinite(id)) throw new Error('Invalid chapter index for delete');

  const del = await api.requestRaw('delete', `${API_PREFIX}/chapter/${id}`, { validateStatus: () => true });
  if (Number(del && del.status) >= 200 && Number(del && del.status) < 400) return true;

  const fallback = await api.requestRaw('get', `${API_PREFIX}/chapter/${id}/delete`, { validateStatus: () => true });
  if (Number(fallback && fallback.status) >= 200 && Number(fallback && fallback.status) < 400) return true;

  throw new Error(`Failed deleting chapter ${id} (HTTP ${fallback && fallback.status ? fallback.status : 'unknown'})`);
}

async function getDownloadsState(api) { return api.get(`${API_PREFIX}/downloads`); }

// ---- WebSocket helpers ---------------------------------------------------

/** Converts an HTTP URL to a WebSocket URL with a different path. */
function toWebSocketUrl(apiUrl, pathSuffix) {
  const u = new URL(apiUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = pathSuffix;
  u.search = '';
  u.hash = '';
  return u.toString();
}

/** Waits for all downloads to finish by listening to WebSocket events. */
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
      try { ws.close(); } catch (e) {}
      if (err) reject(err); else resolve(payload || { done: true });
    };

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => finish(new Error(`Timed out waiting for downloads after ${timeoutMs}ms`)), timeoutMs);
    }

    ws.on('message', raw => {
      let payload;
      try { payload = JSON.parse(String(raw)); } catch (e) { return; }
      const queueLen = Array.isArray(payload.queue) ? payload.queue.length : null;
      if (payload.status === 'Stopped' && queueLen === 0) {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => finish(null, payload), idleGraceMs);
      } else if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    });
    ws.on('error', err => finish(err));
  });
}

/** Gets an instant snapshot of current download state. */
async function getDownloadsSnapshot(apiUrl, timeoutMs = 4000) {
  const wsUrl = toWebSocketUrl(apiUrl, `${API_PREFIX}/downloads`);
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch (e) {}
      reject(new Error(`Timed out waiting for downloads snapshot after ${timeoutMs}ms`));
    }, timeoutMs);

    ws.on('message', raw => {
      if (settled) return;
      let payload;
      try { payload = JSON.parse(String(raw)); } catch (e) { return; }
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch (e) {}
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

module.exports = {
  makeApiClient,
  listExtensions,
  installExtension,
  listSources,
  searchSource,
  addMangaToLibrary,
  removeMangaFromLibrary,
  getMangaChapters,
  getMangaInfo,
  queueChapter,
  startDownloader,
  stopDownloader,
  deleteDownloadedChapter,
  getDownloadsState,
  waitForDownloadsToFinish,
  getDownloadsSnapshot
};
