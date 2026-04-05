/**
 * Komga API client.
 *
 * All HTTP operations for talking to the Komga REST API:
 *  - Library management (create, scan, metadata refresh)
 *  - Series metadata syncing (from AniList / local series.json)
 *  - Metadata patch construction
 *
 * Depends on:
 *  - features/config/infra/config-store.js  (loadConfig)
 *  - features/sync/infra/anilist-adapter.js  (fetchAniListMediaById)  - soft dep
 *  - features/metadata/infra/metadata-index.js (buildListMetadataIndex, etc) - soft dep
 *
 * Functions that depend on other modules import them at the top.
 */
const axios = require('axios');

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/** Builds headers for API Key or Bearer token auth */
function buildKomgaAuthHeaders(cfg) {
  if (cfg && cfg.komgaApiKey) return { 'X-API-Key': String(cfg.komgaApiKey) };
  if (cfg && cfg.komgaToken) return { Authorization: `Bearer ${String(cfg.komgaToken)}` };
  return {};
}

/** Builds the full axios config block (headers + optional Basic auth) */
function buildKomgaAuthConfig(cfg) {
  const headers = buildKomgaAuthHeaders(cfg);
  const auth = (cfg && cfg.komgaUsername && cfg.komgaPassword)
    ? { username: String(cfg.komgaUsername), password: String(cfg.komgaPassword) }
    : undefined;
  return { headers, auth };
}

// ---------------------------------------------------------------------------
// Library management
// ---------------------------------------------------------------------------

/**
 * Requests a per-library deep scan. Falls back to global scan endpoints.
 */
async function triggerKomgaLibraryScan(options = {}) {
  const cfg = loadConfig();
  const authCfg = buildKomgaAuthConfig(cfg);

  const client = axios.create({
    baseURL: cfg.komgaUrl || 'http://localhost:25600',
    timeout: 10000,
    headers: authCfg.headers,
    auth: authCfg.auth,
    validateStatus: () => true
  });

  const listRes = await client.get('/api/v1/libraries');
  if (listRes.status === 401 || listRes.status === 403) {
    throw new Error('Komga auth required for scan.');
  }

  const libs = Array.isArray(listRes.data)
    ? listRes.data
    : (Array.isArray(listRes.data && listRes.data.content) ? listRes.data.content : []);

  let triggered = 0;
  for (const lib of libs) {
    const id = lib && (lib.id || lib.libraryId);
    if (!id) continue;
    const res = await client.post(`/api/v1/libraries/${encodeURIComponent(String(id))}/scan`, {
      scanDeep: options.scanDeep !== false,
      scanForceModifiedTime: options.scanForceModifiedTime === true
    });
    if (res.status >= 200 && res.status < 300) triggered += 1;
  }

  if (triggered > 0) return { ok: true, triggered, strategy: 'per-library' };

  const fallback1 = await client.post('/api/v1/libraries/scan', { scanDeep: false, scanForceModifiedTime: false });
  if (fallback1.status >= 200 && fallback1.status < 300) return { ok: true, triggered: 1, strategy: 'global-libraries-scan' };

  const fallback2 = await client.post('/api/v1/scan', { scanDeep: false, scanForceModifiedTime: false });
  if (fallback2.status >= 200 && fallback2.status < 300) return { ok: true, triggered: 1, strategy: 'global-scan' };

  throw new Error(`Komga scan endpoint not accepted (HTTP ${fallback2.status || fallback1.status || listRes.status}).`);
}

/**
 * Requests per-library metadata refresh. Falls back to global refresh.
 */
async function triggerKomgaMetadataRefresh() {
  const cfg = loadConfig();
  const authCfg = buildKomgaAuthConfig(cfg);
  const baseUrl = cfg.komgaUrl || 'http://localhost:25600';

  const client = axios.create({
    baseURL: baseUrl,
    timeout: 10000,
    headers: authCfg.headers,
    auth: authCfg.auth,
    validateStatus: () => true
  });

  const listRes = await client.get('/api/v1/libraries');
  if (listRes.status === 401 || listRes.status === 403) throw new Error('Komga auth required for metadata refresh.');

  const libs = Array.isArray(listRes.data)
    ? listRes.data
    : (Array.isArray(listRes.data && listRes.data.content) ? listRes.data.content : []);

  let triggered = 0;
  for (const lib of libs) {
    const id = lib && (lib.id || lib.libraryId);
    if (!id) continue;
    const r = await client.post(`/api/v1/libraries/${encodeURIComponent(String(id))}/metadata/refresh`);
    if (r.status >= 200 && r.status < 300) triggered += 1;
  }

  if (triggered > 0) return { ok: true, triggered, strategy: 'per-library' };

  const fallback1 = await client.post('/api/v1/libraries/metadata/refresh');
  if (fallback1.status >= 200 && fallback1.status < 300) return { ok: true, triggered: 1, strategy: 'global-libraries-refresh' };

  const fallback2 = await client.post('/api/v1/metadata/refresh');
  if (fallback2.status >= 200 && fallback2.status < 300) return { ok: true, triggered: 1, strategy: 'global-refresh' };

  throw new Error(`Komga metadata refresh not accepted (HTTP ${fallback2.status}).`);
}

/**
 * Ensures a Komga library exists, creating one with defaults if missing.
 */
async function ensureKomgaLibraryExists(options = {}) {
  const cfg = loadConfig();
  const baseUrl = cfg.komgaUrl || 'http://localhost:25600';
  const downloadsRoot = cfg.downloadsPath || (cfg.dataDir ? require('path').join(cfg.dataDir, 'downloads') : null);
  const root = options.root
    || (cfg.komgaUseDownloadsAsLibrary !== false ? downloadsRoot : (cfg.komgaLibraryPath || (cfg.dataDir ? require('path').join(cfg.dataDir, 'komga-library') : null)));
  const name = String(options.name || cfg.komgaAutoLibraryName || 'mangas-Suwayomi').trim() || 'mangas-Suwayomi';

  if (!root) throw new Error('Library root path is not configured for Komga.');

  const authCfg = buildKomgaAuthConfig(cfg);
  const pathModule = require('path');
  const client = axios.create({
    baseURL: baseUrl,
    timeout: 10000,
    headers: authCfg.headers,
    auth: authCfg.auth,
    validateStatus: () => true
  });

  const listRes = await client.get('/api/v1/libraries');
  if (listRes.status === 401 || listRes.status === 403) throw new Error('Komga auth required to create library.');
  if (!(listRes.status >= 200 && listRes.status < 300)) throw new Error(`Failed to list Komga libraries (HTTP ${listRes.status}).`);

  const libs = Array.isArray(listRes.data) ? listRes.data : (Array.isArray(listRes.data && listRes.data.content) ? listRes.data.content : []);
  const normalizedRoot = pathModule.resolve(root);
  const existing = libs.find(lib => {
    const libName = String(lib && (lib.name || '')).trim().toLowerCase();
    const libRoot = String(lib && (lib.root || lib.path || '')).trim();
    return libName === name.toLowerCase() || (libRoot && pathModule.resolve(libRoot) === normalizedRoot);
  });

  if (existing) return { created: false, name: existing.name || name, root: existing.root || root, id: existing.id || existing.libraryId || null };

  const payload = { name, root, importComicInfoBook: true, importComicInfoSeries: true, importLocalArtwork: true, scanForceModifiedTime: false, scanDeep: true };
  const createRes = await client.post('/api/v1/libraries', payload);
  if (!(createRes.status >= 200 && createRes.status < 300)) throw new Error(`Failed to create Komga library "${name}" (HTTP ${createRes.status}).`);

  const data = createRes.data || {};
  return { created: true, name: data.name || name, root: data.root || root, id: data.id || data.libraryId || null };
}

// ---------------------------------------------------------------------------
// Metadata patching
// ---------------------------------------------------------------------------

function decodeHtmlEntities(text) {
  return String(text || '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function toEnglishSummaryText(itemMeta) {
  const raw = itemMeta && itemMeta.description ? String(itemMeta.description) : '';
  return decodeHtmlEntities(raw).replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

function mapKomgaStatusFromAniList(rawStatus) {
  const s = String(rawStatus || '').toUpperCase();
  if (s === 'FINISHED' || s === 'COMPLETED') return 'ENDED';
  if (s === 'HIATUS') return 'HIATUS';
  if (s === 'CANCELLED') return 'ABANDONED';
  if (s) return 'ONGOING';
  return null;
}

function toKomgaAlternateTitles(itemMeta) {
  const out = [];
  const seen = new Set();
  for (const t of (itemMeta && Array.isArray(itemMeta.altTitles) ? itemMeta.altTitles : [])) {
    const title = String(t || '').trim();
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    out.push({ label: 'anilist', title });
    if (out.length >= 20) break;
  }
  return out;
}

/** Builds a PATCH payload for updating a series' metadata */
function buildKomgaSeriesMetadataPatch(itemMeta, existingMetadata = null) {
  if (!itemMeta) return null;

  const summary = toEnglishSummaryText(itemMeta);
  const summaryOut = summary || String(existingMetadata && existingMetadata.summary || '').trim() || 'Sinopse indisponivel no AniList.';
  const language = itemMeta && itemMeta.countryOfOrigin
    ? ({ JP: 'ja', KR: 'ko', CN: 'zh', TW: 'zh', US: 'en' }[String(itemMeta.countryOfOrigin).toUpperCase()] || '') : '';
  const total = Number.isFinite(Number(itemMeta.totalChapters)) ? Number(itemMeta.totalChapters) : null;
  const status = mapKomgaStatusFromAniList(itemMeta.mediaStatus || itemMeta.status);
  const alternateTitles = toKomgaAlternateTitles(itemMeta);
  const genres = (Array.isArray(itemMeta.genres) ? itemMeta.genres : []).map(x => String(x || '').trim().toLowerCase()).filter(Boolean).slice(0, 20);

  const payload = {};
  if (String(itemMeta.title || '').trim()) { payload.title = String(itemMeta.title).trim(); payload.titleSort = payload.title; }
  if (summaryOut) payload.summary = summaryOut;
  if (language) payload.language = language;
  if (Number.isFinite(total) && total > 0) payload.totalBookCount = total;
  if (status) payload.status = status;
  if (String(itemMeta.publisher || '').trim()) payload.publisher = String(itemMeta.publisher).trim();
  if (genres.length) payload.genres = genres;
  if (alternateTitles.length) payload.alternateTitles = alternateTitles;

  return Object.keys(payload).length ? payload : null;
}

module.exports = {
  buildKomgaAuthHeaders,
  buildKomgaAuthConfig,
  triggerKomgaLibraryScan,
  triggerKomgaMetadataRefresh,
  ensureKomgaLibraryExists,
  buildKomgaSeriesMetadataPatch,
  decodeHtmlEntities,
  toEnglishSummaryText,
  mapKomgaStatusFromAniList,
  toKomgaAlternateTitles
};

const { loadConfig } = require('../../config/infra/config-store');
