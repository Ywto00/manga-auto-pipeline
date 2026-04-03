const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const { execFileSync } = require('child_process');

const { fetchAniList, fetchAniListMediaById } = require('./shared/adapters/anilist.adapter');
const { fetchMAL } = require('./shared/adapters/mal.adapter');
const { normalize } = require('./shared/utils/normalize');
const { postGraphQL } = require('./shared/utils/api-common');
const {
  startSuwayomiJar,
  startKomgaJar,
  waitForReady,
  makeApiClient,
  searchAndEnqueue,
  quotePathForHocon,
  listExtensions,
  installExtension,
  listSources,
  searchSource,
  removeMangaFromLibrary,
  getMangaChapters,
  deleteDownloadedChapter,
  stopDownloader,
  getDownloadsState,
  getDownloadsSnapshot,
  waitForDownloadsToFinish
} = require('./bridge');

const DEV_DATA_ROOT = path.join(__dirname, '..', 'data');
const PACKAGED_STATE_ROOT = path.join(
  process.env.APPDATA || path.join(os.homedir(), '.config'),
  'manga-auto-pipeline'
);
const PACKAGED_BOOTSTRAP_PATH = path.join(PACKAGED_STATE_ROOT, 'runtime.json');
const DEFAULT_MANAGED_DIR = path.join(os.homedir(), 'MangaPipeline');
const DATA_DIR_ENV_KEY = 'MANGA_PIPELINE_DATA_DIR';

function readPackagedBootstrap() {
  try {
    const txt = fs.readFileSync(PACKAGED_BOOTSTRAP_PATH, 'utf8') || '{}';
    const parsed = JSON.parse(txt);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (e) {
    // ignore
  }
  return {};
}

function writePackagedBootstrap(dataDir) {
  const dir = String(dataDir || '').trim() || DEFAULT_MANAGED_DIR;
  fs.mkdirSync(path.dirname(PACKAGED_BOOTSTRAP_PATH), { recursive: true });
  fs.writeFileSync(PACKAGED_BOOTSTRAP_PATH, JSON.stringify({ dataDir: dir }, null, 2), 'utf8');
}

function hasConfigAt(root) {
  if (!root) return false;
  return fs.existsSync(path.join(root, 'config.json'));
}

function toDataRootFromDir(baseDir) {
  const raw = String(baseDir || '').trim();
  if (!raw) return null;
  return path.join(path.resolve(raw), 'data');
}

function readDataDirFromConfigFile(configPath) {
  try {
    if (!configPath || !fs.existsSync(configPath)) return '';
    const txt = fs.readFileSync(configPath, 'utf8') || '{}';
    const parsed = JSON.parse(txt);
    return String(parsed && parsed.dataDir || '').trim();
  } catch (e) {
    return '';
  }
}

function resolveDataRoot(explicitDataDir = null) {
  if (explicitDataDir) {
    return toDataRootFromDir(explicitDataDir);
  }

  const bootstrap = readPackagedBootstrap();
  const envRoot = toDataRootFromDir(process.env[DATA_DIR_ENV_KEY]);
  const bootstrapRoot = toDataRootFromDir(bootstrap.dataDir);
  const legacyRepoConfigPath = path.join(DEV_DATA_ROOT, 'config.json');
  const legacyDeclaredRoot = toDataRootFromDir(readDataDirFromConfigFile(legacyRepoConfigPath));
  const defaultManagedRoot = toDataRootFromDir(DEFAULT_MANAGED_DIR);

  const preferred = [envRoot, bootstrapRoot, legacyDeclaredRoot, defaultManagedRoot, DEV_DATA_ROOT].filter(Boolean);
  for (const root of preferred) {
    if (hasConfigAt(root)) return root;
  }

  // If no config exists yet, keep repo-data behavior in dev and managed behavior in packaged builds.
  if (process && process.pkg) return defaultManagedRoot;
  return DEV_DATA_ROOT;
}

function getDataPaths(explicitDataDir = null) {
  const root = resolveDataRoot(explicitDataDir);
  return {
    root,
    config: path.join(root, 'config.json'),
    list: path.join(root, 'list.json'),
    downloads: path.join(root, 'downloads.json'),
    linkCache: path.join(root, 'link-cache.json')
  };
}

function getConfigPath() {
  return getDataPaths().config;
}

function getListPath() {
  return getDataPaths().list;
}

function getDownloadsPath() {
  return getDataPaths().downloads;
}

function getLinkCachePath() {
  return getDataPaths().linkCache;
}

const CONFIG_PATH = getConfigPath();
const LIST_PATH = getListPath();
const DOWNLOADS_PATH = getDownloadsPath();
const LINK_CACHE_PATH = getLinkCachePath();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadConfig() {
  const configPath = getConfigPath();
  try {
    const txt = fs.readFileSync(configPath, 'utf8') || '{}';
    const cfg = JSON.parse(txt);
    const bootstrap = readPackagedBootstrap();
    cfg.dataDir = String(cfg.dataDir || bootstrap.dataDir || DEFAULT_MANAGED_DIR).trim() || DEFAULT_MANAGED_DIR;
    return cfg;
  } catch (e) {
    const bootstrap = readPackagedBootstrap();
    return {
      dataDir: String(bootstrap.dataDir || DEFAULT_MANAGED_DIR).trim() || DEFAULT_MANAGED_DIR
    };
  }
}

function saveConfig(cfg) {
  const explicitDataDir = cfg && cfg.dataDir ? String(cfg.dataDir).trim() : null;
  if (explicitDataDir) {
    writePackagedBootstrap(explicitDataDir);
  }
  const configPath = getDataPaths(explicitDataDir).config;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
}

function upsertHoconLine(hoconText, key, rawValue) {
  const rx = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\\]\\]/g, '\\\\$&')}\\s*=.*$`, 'm');
  const line = `${key} = ${rawValue}`;
  if (rx.test(hoconText)) return hoconText.replace(rx, line);
  const suffix = hoconText.endsWith('\n') ? '' : '\n';
  return `${hoconText}${suffix}${line}\n`;
}

function toHoconString(v) {
  const s = String(v || '').replace(/\\/g, '/').replace(/"/g, '\\"');
  return `"${s}"`;
}

function toHoconStringArray(values) {
  const items = (values || []).map(v => `  ${toHoconString(v)}`).join(',\n');
  return `[\n${items}\n]`;
}

function replaceHoconArrayBlock(hoconText, key, arrayRawValue) {
  const keyEscaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blockPattern = new RegExp(`^\\s*${keyEscaped}\\s*=\\s*\\[[\\s\\S]*?^\\s*\\]\\s*$`, 'm');
  const singleLinePattern = new RegExp(`^\\s*${keyEscaped}\\s*=.*$`, 'm');
  const newBlock = `${key} = ${arrayRawValue}`;

  if (blockPattern.test(hoconText)) return hoconText.replace(blockPattern, newBlock);
  if (singleLinePattern.test(hoconText)) return hoconText.replace(singleLinePattern, newBlock);
  const suffix = hoconText.endsWith('\n') ? '' : '\n';
  return `${hoconText}${suffix}${newBlock}\n`;
}

function syncServerConf(cfg) {
  if (!cfg || !cfg.dataDir) return;
  const confPath = path.join(cfg.dataDir, 'server.conf');
  let txt = '';
  if (fs.existsSync(confPath)) {
    txt = fs.readFileSync(confPath, 'utf8');
  }

  txt = upsertHoconLine(txt, 'server.systemTrayEnabled', 'false');
  txt = upsertHoconLine(txt, 'server.initialOpenInBrowserEnabled', 'false');
  txt = upsertHoconLine(txt, 'server.webUIEnabled', cfg.suwayomiWebUIEnabled ? 'true' : 'false');
  txt = upsertHoconLine(txt, 'server.ip', toHoconString(cfg.serverBindIp || '0.0.0.0'));
  txt = upsertHoconLine(txt, 'server.downloadAsCbz', 'true');
  txt = upsertHoconLine(txt, 'server.downloadsPath', toHoconString(quotePathForHocon(cfg.downloadsPath || '')));
  if (Number.isFinite(Number(cfg.maxSourcesInParallel)) && Number(cfg.maxSourcesInParallel) >= 1) {
    txt = upsertHoconLine(txt, 'server.maxSourcesInParallel', String(Number(cfg.maxSourcesInParallel)));
  }

  if (Array.isArray(cfg.extensionRepos) && cfg.extensionRepos.length > 0) {
    txt = replaceHoconArrayBlock(txt, 'server.extensionRepos', toHoconStringArray(cfg.extensionRepos));
  }

  fs.mkdirSync(path.dirname(confPath), { recursive: true });
  fs.writeFileSync(confPath, txt, 'utf8');
}

function isConfigComplete(cfg) {
  return Boolean(
    cfg &&
    cfg.jarPath &&
    cfg.dataDir &&
    cfg.downloadsPath &&
    (cfg.usernameAnilist || cfg.usernameMal) &&
    cfg.capsAhead
  );
}

function moveJarToManagedFolder(sourceJarPath, managedDir, overwrite = true) {
  if (!sourceJarPath) return sourceJarPath;
  fs.mkdirSync(managedDir, { recursive: true });
  const targetJarPath = path.join(managedDir, path.basename(sourceJarPath));
  if (path.resolve(sourceJarPath) === path.resolve(targetJarPath)) return targetJarPath;
  if (overwrite && fs.existsSync(targetJarPath)) {
    fs.unlinkSync(targetJarPath);
  }
  try {
    fs.renameSync(sourceJarPath, targetJarPath);
  } catch (e) {
    fs.copyFileSync(sourceJarPath, targetJarPath);
    fs.unlinkSync(sourceJarPath);
  }
  return targetJarPath;
}

function applyConfigValues(values) {
  const current = loadConfig();
  const cfg = { ...current, ...values };

  cfg.apiUrl = cfg.apiUrl || 'http://localhost:4567';
  cfg.serverBindIp = String(cfg.serverBindIp || '0.0.0.0').trim() || '0.0.0.0';
  cfg.komgaUrl = cfg.komgaUrl || 'http://localhost:25600';
  cfg.extensionRepos = cfg.extensionRepos || [];
  if (cfg.dataDir) {
    cfg.downloadsPath = cfg.downloadsPath || path.join(cfg.dataDir, 'downloads');
    cfg.komgaDataDir = cfg.komgaDataDir || path.join(cfg.dataDir, 'komga');
    cfg.komgaLibraryPath = cfg.komgaLibraryPath || path.join(cfg.dataDir, 'komga-library');
  }
  cfg.usernameAnilist = cfg.usernameAnilist || '';
  cfg.usernameMal = cfg.usernameMal || '';
  cfg.capsAhead = Number(cfg.capsAhead) || 5;
  cfg.maxSourcesInParallel = Number(cfg.maxSourcesInParallel) || 6;
  cfg.suwayomiWebUIEnabled = Boolean(cfg.suwayomiWebUIEnabled);
  cfg.strictTitleMatch = cfg.strictTitleMatch !== false;
  cfg.strictMinScore = Math.max(60, Math.min(99, Number(cfg.strictMinScore || 88)));
  cfg.linkCacheTtlMinutes = Math.max(10, Number(cfg.linkCacheTtlMinutes || 720));
  cfg.maxExtensionsForAutoLink = Math.max(1, Math.min(50, Number(cfg.maxExtensionsForAutoLink || 12)));
  cfg.cleanupLibraryDuplicates = cfg.cleanupLibraryDuplicates !== false;
  cfg.persistSwitchedSourceLink = cfg.persistSwitchedSourceLink !== false;
  cfg.komgaUseDownloadsAsLibrary = cfg.komgaUseDownloadsAsLibrary !== false;
  cfg.komgaSyncOnStart = cfg.komgaSyncOnStart !== false;
  cfg.komgaAutoLibraryName = String(cfg.komgaAutoLibraryName || 'mangas-Suwayomi').trim() || 'mangas-Suwayomi';
  cfg.komgaOrganizeMode = cfg.komgaOrganizeMode === 'copy' ? 'copy' : 'hardlink';
  cfg.komgaCreateGhostFolders = cfg.komgaCreateGhostFolders === true;
  cfg.komgaCreateSeriesMetadata = cfg.komgaCreateSeriesMetadata !== false;
  cfg.komgaCreateSeriesCover = cfg.komgaCreateSeriesCover !== false;
  cfg.apiTimeoutMs = Math.max(5000, Number(cfg.apiTimeoutMs || 30000));
  cfg.enqueueRetryAttempts = Math.max(1, Math.min(5, Number(cfg.enqueueRetryAttempts || 2)));
  cfg.preferredSearchLangs = Array.isArray(cfg.preferredSearchLangs)
    ? cfg.preferredSearchLangs.map(x => String(x || '').toLowerCase()).filter(Boolean).slice(0, 5)
    : [];

  saveConfig(cfg);
  syncServerConf(cfg);
  return cfg;
}

function sanitizeFsName(name) {
  return String(name || 'unknown')
    .replace(/[<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function walkFilesRecursively(root) {
  const out = [];
  if (!root || !fs.existsSync(root)) return out;

  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    const entries = fs.readdirSync(cur, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else {
        out.push(full);
      }
    }
  }
  return out;
}

function inferSeriesNameFromCbz(cbzPath, downloadsRoot) {
  const rel = path.relative(downloadsRoot, cbzPath);
  const parts = rel.split(path.sep).filter(Boolean);
  if (parts.length >= 3) {
    return sanitizeFsName(parts[parts.length - 2]);
  }

  const base = sanitizeFsName(path.basename(cbzPath, path.extname(cbzPath)));
  return base.replace(/\b(ch|chapter|cap|c)\s*\d+(\.\d+)?\b/gi, '').trim() || base;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function normalizeSeriesKey(name) {
  return normalize(String(name || '')).trim().toLowerCase();
}

function readListRawAll() {
  const listPath = getListPath();
  try {
    const txt = fs.existsSync(listPath) ? (fs.readFileSync(listPath, 'utf8') || '[]') : '[]';
    const parsed = JSON.parse(txt);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function buildListMetadataIndex() {
  const map = new Map();
  const byId = new Map();

  function addAlias(alias, item) {
    const key = normalizeSeriesKey(alias);
    if (!key || !item) return;
    if (!map.has(key)) map.set(key, item);
  }

  for (const item of readListRawAll()) {
    const id = Number(item && item.id);
    if (Number.isFinite(id) && !byId.has(id)) byId.set(id, item);

    const keys = [];
    keys.push(normalizeSeriesKey(item.title || ''));
    keys.push(normalizeSeriesKey(item.searchKey || ''));

    if (Array.isArray(item.altTitles)) {
      for (const alt of item.altTitles) keys.push(normalizeSeriesKey(alt));
    }

    for (const key of keys.filter(Boolean)) {
      addAlias(key, item);
    }
  }

  const downloads = loadDownloadsRegistry();
  for (const [itemKey, entry] of Object.entries(downloads.items || {})) {
    const parts = String(itemKey || '').split(':');
    const idFromKey = Number(parts[1]);
    const id = Number.isFinite(Number(entry && entry.id)) ? Number(entry.id) : (Number.isFinite(idFromKey) ? idFromKey : null);
    const item = Number.isFinite(id) ? byId.get(id) : null;
    if (!item) continue;

    addAlias(entry.title || '', item);
    addAlias(entry.searchKey || '', item);
    addAlias(entry.matchedMangaTitle || '', item);
  }

  const cache = loadLinkCache();
  for (const [itemKey, entry] of Object.entries(cache.items || {})) {
    const parts = String(itemKey || '').split(':');
    const idFromKey = Number(parts[1]);
    const item = Number.isFinite(idFromKey) ? byId.get(idFromKey) : null;
    if (!item) continue;

    const best = entry && entry.best ? entry.best : null;
    addAlias(best && best.mangaTitle ? best.mangaTitle : '', item);
    addAlias(best && best.matchedAgainst ? best.matchedAgainst : '', item);
    if (Array.isArray(entry && entry.sources)) {
      for (const s of entry.sources) {
        if (!Array.isArray(s && s.mangas)) continue;
        for (const m of s.mangas.slice(0, 5)) {
          addAlias(m && m.title ? m.title : '', item);
          addAlias(m && m.matchedAgainst ? m.matchedAgainst : '', item);
        }
      }
    }
  }

  return map;
}

function buildListMetadataById() {
  const map = new Map();
  for (const item of readListRawAll()) {
    const id = Number(item && item.id);
    if (!Number.isFinite(id)) continue;
    if (!map.has(id)) map.set(id, item);
  }
  return map;
}

function buildSeriesJsonMetadataIndex(rootDirs = []) {
  const map = new Map();
  const seenFiles = new Set();

  function addAlias(alias, item) {
    const key = normalizeSeriesKey(alias);
    if (!key || !item) return;
    if (!map.has(key)) map.set(key, item);
  }

  function toItemMeta(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const status = raw.anilistStatus || raw.status || '';
    return {
      id: Number.isFinite(Number(raw.anilistId)) ? Number(raw.anilistId) : null,
      title: raw.title || raw.name || '',
      description: raw.description || raw.description_text || raw.description_formatted || '',
      altTitles: Array.isArray(raw.altTitles)
        ? raw.altTitles
        : (Array.isArray(raw.alternate_names) ? raw.alternate_names : []),
      siteUrl: raw.siteUrl || '',
      countryOfOrigin: raw.countryOfOrigin || '',
      totalChapters: Number.isFinite(Number(raw.totalChapters)) ? Number(raw.totalChapters) : null,
      mediaStatus: status,
      status,
      startYear: Number.isFinite(Number(raw.startYear)) ? Number(raw.startYear) : null
    };
  }

  for (const root of rootDirs) {
    if (!root || !fs.existsSync(root)) continue;
    const files = walkFilesRecursively(root).filter(f => path.basename(f).toLowerCase() === 'series.json');
    for (const file of files) {
      const abs = path.resolve(file);
      if (seenFiles.has(abs)) continue;
      seenFiles.add(abs);

      try {
        const txt = fs.readFileSync(file, 'utf8') || '{}';
        const raw = JSON.parse(txt);
        const itemMeta = toItemMeta(raw);
        if (!itemMeta) continue;

        addAlias(raw.name || '', itemMeta);
        addAlias(raw.title || '', itemMeta);
        if (Array.isArray(itemMeta.altTitles)) {
          for (const alt of itemMeta.altTitles) addAlias(alt, itemMeta);
        }
      } catch (e) {
        // Ignore malformed series.json files.
      }
    }
  }

  return map;
}

function readSeriesJsonMetadata(seriesDir) {
  if (!seriesDir) return null;
  const file = path.join(seriesDir, 'series.json');
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
    const status = raw.anilistStatus || raw.status || '';
    return {
      id: Number.isFinite(Number(raw.anilistId)) ? Number(raw.anilistId) : null,
      title: raw.title || raw.name || '',
      description: raw.description || raw.description_text || raw.description_formatted || '',
      altTitles: Array.isArray(raw.altTitles)
        ? raw.altTitles
        : (Array.isArray(raw.alternate_names) ? raw.alternate_names : []),
      siteUrl: raw.siteUrl || '',
      countryOfOrigin: raw.countryOfOrigin || '',
      totalChapters: Number.isFinite(Number(raw.totalChapters)) ? Number(raw.totalChapters) : null,
      mediaStatus: status,
      status,
      startYear: Number.isFinite(Number(raw.startYear)) ? Number(raw.startYear) : null,
      publisher: raw.publisher || '',
      genres: Array.isArray(raw.genres) ? raw.genres : []
    };
  } catch (e) {
    return null;
  }
}

function mergeItemMetadata(...items) {
  const valid = items.filter(Boolean);
  if (!valid.length) return null;

  const best = {
    ...valid[0],
    altTitles: [],
    genres: []
  };
  const altSet = new Set();
  const genreSet = new Set();

  function takeString(key, value) {
    const v = String(value || '').trim();
    const cur = String(best[key] || '').trim();
    if (!v) return;
    if (!cur || v.length > cur.length) best[key] = v;
  }

  function takeNumber(key, value) {
    const n = Number(value);
    if (Number.isFinite(n)) best[key] = n;
  }

  for (const item of valid) {
    takeNumber('id', item.id);
    takeString('title', item.title);
    takeString('description', item.description);
    takeString('siteUrl', item.siteUrl);
    takeString('countryOfOrigin', item.countryOfOrigin);
    takeString('mediaStatus', item.mediaStatus || item.status);
    takeString('status', item.status || item.mediaStatus);
    takeString('publisher', item.publisher);
    takeNumber('totalChapters', item.totalChapters);
    takeNumber('startYear', item.startYear);

    if (Array.isArray(item.altTitles)) {
      for (const t of item.altTitles) {
        const s = String(t || '').trim();
        if (!s) continue;
        const k = s.toLowerCase();
        if (altSet.has(k)) continue;
        altSet.add(k);
        best.altTitles.push(s);
      }
    }

    if (Array.isArray(item.genres)) {
      for (const g of item.genres) {
        const s = String(g || '').trim();
        if (!s) continue;
        const k = s.toLowerCase();
        if (genreSet.has(k)) continue;
        genreSet.add(k);
        best.genres.push(s);
      }
    }
  }

  best.altTitles = best.altTitles.slice(0, 20);
  best.genres = best.genres.slice(0, 20);
  return best;
}

function findSeriesMetadata(seriesName, metadataIndex) {
  if (!metadataIndex || !seriesName) return null;
  const key = normalizeSeriesKey(seriesName);
  if (!key) return null;

  const direct = metadataIndex.get(key);
  if (direct) return direct;

  if (key.length >= 6) {
    for (const [k, item] of metadataIndex.entries()) {
      if (!k || k.length < 6) continue;
      if (k.includes(key) || key.includes(k)) return item;
    }
  }

  return null;
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function toEnglishSummaryText(itemMeta) {
  const raw = itemMeta && itemMeta.description ? String(itemMeta.description) : '';
  const cleaned = decodeHtmlEntities(raw)
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return cleaned;
}

function writeSeriesMetadataFile(seriesDir, seriesName, itemMeta) {
  const totalIssues = itemMeta && Number.isFinite(Number(itemMeta.totalChapters))
    ? Number(itemMeta.totalChapters)
    : null;
  const year = itemMeta && Number.isFinite(Number(itemMeta.startYear))
    ? Number(itemMeta.startYear)
    : null;
  const statusRaw = itemMeta && (itemMeta.mediaStatus || itemMeta.status)
    ? String(itemMeta.mediaStatus || itemMeta.status).toLowerCase()
    : '';
  const status = statusRaw === 'finished' || statusRaw === 'completed' ? 'Ended' : (statusRaw ? 'Continuing' : '');
  const altTitles = itemMeta && Array.isArray(itemMeta.altTitles)
    ? itemMeta.altTitles.map(x => String(x || '').trim()).filter(Boolean).slice(0, 20)
    : [];
  const summary = toEnglishSummaryText(itemMeta);
  const language = itemMeta && itemMeta.countryOfOrigin
    ? ({ JP: 'ja', KR: 'ko', CN: 'zh', TW: 'zh', US: 'en' }[String(itemMeta.countryOfOrigin).toUpperCase()] || '')
    : '';
  const genres = itemMeta && Array.isArray(itemMeta.genres) ? itemMeta.genres.filter(Boolean) : [];

  const payload = {
    // Mylar-compatible fields used by Komga when "Import metadata generated by Mylar" is enabled.
    name: seriesName,
    year,
    status,
    description_formatted: summary,
    description_text: summary,
    publisher: itemMeta && itemMeta.publisher ? String(itemMeta.publisher) : '',
    age_rating: 0,
    total_issues: totalIssues,
    language,
    genres,
    aliases: altTitles,
    alternate_names: altTitles,
    alternative_titles: altTitles,

    // Extra fields for pipeline diagnostics and traceability.
    title: seriesName,
    titleSort: seriesName,
    anilistStatus: itemMeta && itemMeta.status ? String(itemMeta.status) : '',
    anilistId: itemMeta && itemMeta.id ? Number(itemMeta.id) : null,
    source: itemMeta && itemMeta.source ? String(itemMeta.source) : '',
    progress: itemMeta && Number.isFinite(Number(itemMeta.progress)) ? Number(itemMeta.progress) : null,
    totalChapters: itemMeta && Number.isFinite(Number(itemMeta.totalChapters)) ? Number(itemMeta.totalChapters) : null,
    totalVolumes: itemMeta && Number.isFinite(Number(itemMeta.totalVolumes)) ? Number(itemMeta.totalVolumes) : null,
    format: itemMeta && itemMeta.format ? String(itemMeta.format) : '',
    countryOfOrigin: itemMeta && itemMeta.countryOfOrigin ? String(itemMeta.countryOfOrigin) : '',
    siteUrl: itemMeta && itemMeta.siteUrl ? String(itemMeta.siteUrl) : '',
    startYear: itemMeta && Number.isFinite(Number(itemMeta.startYear)) ? Number(itemMeta.startYear) : null,
    coverImageUrl: itemMeta && itemMeta.coverImage && (itemMeta.coverImage.extraLarge || itemMeta.coverImage.large || itemMeta.coverImage.medium)
      ? String(itemMeta.coverImage.extraLarge || itemMeta.coverImage.large || itemMeta.coverImage.medium)
      : '',
    altTitles,
    generatedBy: 'manga-auto-pipeline',
    generatedAt: new Date().toISOString()
  };

  const target = path.join(seriesDir, 'series.json');
  fs.writeFileSync(target, JSON.stringify(payload, null, 2), 'utf8');
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function writeSeriesComicInfoFile(seriesDir, seriesName, itemMeta) {
  const total = itemMeta && Number.isFinite(Number(itemMeta.totalChapters))
    ? Number(itemMeta.totalChapters)
    : '';
  const year = itemMeta && Number.isFinite(Number(itemMeta.startYear))
    ? Number(itemMeta.startYear)
    : '';
  const alt = itemMeta && Array.isArray(itemMeta.altTitles)
    ? itemMeta.altTitles.map(x => String(x || '').trim()).filter(Boolean).slice(0, 10)
    : [];
  const summary = toEnglishSummaryText(itemMeta);

  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<ComicInfo>',
    `  <Series>${escapeXml(seriesName)}</Series>`,
    `  <Summary>${escapeXml(summary)}</Summary>`,
    `  <Year>${escapeXml(year)}</Year>`,
    `  <Count>${escapeXml(total)}</Count>`,
    '</ComicInfo>',
    ''
  ].join('\n');

  fs.writeFileSync(path.join(seriesDir, 'ComicInfo.xml'), xml, 'utf8');
}

function findCoverCandidate(sourceDir) {
  if (!sourceDir || !fs.existsSync(sourceDir)) return null;
  const names = [
    'cover.jpg',
    'cover.jpeg',
    'cover.png',
    'folder.jpg',
    'folder.jpeg',
    'folder.png',
    'poster.jpg',
    'poster.jpeg',
    'poster.png'
  ];

  for (const name of names) {
    const candidate = path.join(sourceDir, name);
    if (fs.existsSync(candidate)) return candidate;
  }

  const lowerPriorityFolders = ['thumbnails', 'thumbnail', '.thumbnails', '.thumbnail', 'thumbs', 'images'];
  for (const folder of lowerPriorityFolders) {
    const dir = path.join(sourceDir, folder);
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir)
      .filter(name => /\.(jpe?g|png|webp)$/i.test(name))
      .sort();
    if (files.length) return path.join(dir, files[0]);
  }

  // Last fallback: any image file at series source root.
  const rootImages = fs.readdirSync(sourceDir)
    .filter(name => /\.(jpe?g|png|webp)$/i.test(name))
    .sort();
  if (rootImages.length) return path.join(sourceDir, rootImages[0]);

  return null;
}

function getAniListCoverUrl(itemMeta) {
  if (!itemMeta || !itemMeta.coverImage) return '';
  return String(itemMeta.coverImage.extraLarge || itemMeta.coverImage.large || itemMeta.coverImage.medium || '').trim();
}

async function fetchAniListCoverUrlById(anilistId) {
  const id = Number(anilistId);
  if (!Number.isFinite(id)) return '';

  const query = `
    query ($id: Int) {
      Media(id: $id, type: MANGA) {
        coverImage {
          extraLarge
          large
          medium
        }
      }
    }
  `;

  try {
    const data = await postGraphQL(query, { id });
    const cover = data && data.Media && data.Media.coverImage ? data.Media.coverImage : null;
    return String((cover && (cover.extraLarge || cover.large || cover.medium)) || '').trim();
  } catch (e) {
    return '';
  }
}

async function downloadCoverFromUrl(url, seriesDir) {
  let response = null;
  const headers = {
    'User-Agent': 'manga-auto-pipeline/1.0',
    Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
  };

  for (let i = 0; i < 3; i += 1) {
    response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers,
      validateStatus: () => true
    });
    if (response.status >= 200 && response.status < 300) break;
    if (response.status !== 429 && response.status < 500) break;
    await sleep(500 * (i + 1));
  }

  if (!response || !(response.status >= 200 && response.status < 300)) {
    throw new Error(`cover-download-http-${response ? response.status : 'no-response'}`);
  }

  const contentType = String((response.headers && response.headers['content-type']) || '').toLowerCase();
  let ext = '.jpg';
  if (contentType.includes('png')) ext = '.png';
  if (contentType.includes('webp')) ext = '.webp';

  const target = path.join(seriesDir, `cover${ext}`);
  fs.writeFileSync(target, Buffer.from(response.data));
  return target;
}

async function ensureSeriesCoverFile(seriesDir, sourceDir, itemMeta) {
  const existing = ['cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp']
    .map(name => path.join(seriesDir, name))
    .find(p => fs.existsSync(p));
  if (existing) return 'already-exists';

  let coverUrl = getAniListCoverUrl(itemMeta);
  if (!coverUrl && itemMeta && itemMeta.id) {
    coverUrl = await fetchAniListCoverUrlById(itemMeta.id);
  }
  if (coverUrl) {
    try {
      await downloadCoverFromUrl(coverUrl, seriesDir);
      return 'created-from-anilist';
    } catch (e) {
      // fallback to local images below
    }
  }

  const candidate = findCoverCandidate(sourceDir);
  if (candidate) {
    const ext = path.extname(candidate).toLowerCase() || '.jpg';
    const target = path.join(seriesDir, `cover${ext}`);
    fs.copyFileSync(candidate, target);
    return 'created';
  }

  return 'not-found';
}

function linkOrCopyFile(src, dest, mode = 'copy') {
  if (fs.existsSync(dest)) return 'skipped-exists';
  ensureDir(path.dirname(dest));
  if (mode === 'hardlink') {
    try {
      fs.linkSync(src, dest);
      return 'linked';
    } catch (e) {
      fs.copyFileSync(src, dest);
      return 'copied-fallback';
    }
  }
  fs.copyFileSync(src, dest);
  return 'copied';
}

function moveFile(src, dest) {
  if (fs.existsSync(dest)) return 'skipped-exists';
  ensureDir(path.dirname(dest));
  try {
    fs.renameSync(src, dest);
    return 'moved';
  } catch (e) {
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
    return 'moved';
  }
}

function buildWantedChapterNumbers(progress, capsAhead) {
  const out = [];
  const p = Number(progress || 0);
  const c = Number(capsAhead || 0);
  const start = p > 0 ? p : 1;
  for (let i = 0; i < c; i += 1) out.push(start + i);
  return out;
}

function toLocalYmd(value) {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function shouldSkipKomgaSyncToday(lastSyncAt) {
  if (!lastSyncAt) return false;
  return toLocalYmd(lastSyncAt) === toLocalYmd(new Date());
}

async function startServer() {
  const cfg = loadConfig();
  if (!cfg.jarPath) throw new Error('No JAR configured.');
  if (!cfg.dataDir) throw new Error('No data folder configured.');

  cfg.downloadsPath = cfg.downloadsPath || path.join(cfg.dataDir, 'downloads');
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.mkdirSync(cfg.downloadsPath, { recursive: true });
  syncServerConf(cfg);
  saveConfig(cfg);

  const runner = startSuwayomiJar(cfg.jarPath, {
    javaArgs: cfg.javaArgs || [],
    detached: true,
    configOverrides: {
      'server.rootDir': cfg.dataDir,
      'server.downloadsPath': cfg.downloadsPath,
      'server.systemTrayEnabled': false,
      'server.initialOpenInBrowserEnabled': false,
      'server.webUIEnabled': Boolean(cfg.suwayomiWebUIEnabled),
      'server.ip': cfg.serverBindIp || '0.0.0.0',
      'server.downloadAsCbz': true,
      'server.maxSourcesInParallel': Number(cfg.maxSourcesInParallel) || 6,
      ...(Array.isArray(cfg.extensionRepos) && cfg.extensionRepos.length
        ? { 'server.extensionRepos': cfg.extensionRepos }
        : {})
    }
  });

  const apiUrl = cfg.apiUrl || 'http://localhost:4567';
  let ready = false;
  for (let i = 0; i < 6; i += 1) {
    try {
      await waitForReady(apiUrl, 2000, 500);
      ready = true;
      break;
    } catch (e) {
      await sleep(200);
    }
  }

  cfg._runnerPid = runner.proc.pid;
  saveConfig(cfg);

  return { cfg, ready, pid: runner.proc.pid, apiUrl };
}

async function waitForKomgaReady(komgaUrl, timeoutMs = 30000, intervalMs = 1000) {
  const startAt = Date.now();
  while (Date.now() - startAt < timeoutMs) {
    try {
      const res = await axios.get(komgaUrl, {
        timeout: 3000,
        validateStatus: () => true
      });
      if (res && res.status >= 200 && res.status < 500) return true;
    } catch (e) {
      // ignore and retry
    }
    await sleep(intervalMs);
  }
  return false;
}

async function startKomga() {
  const cfg = loadConfig();
  if (!cfg.komgaJarPath) throw new Error('No Komga JAR configured.');
  if (!cfg.dataDir) throw new Error('No data folder configured.');

  const managedJarDir = path.join(cfg.dataDir, 'bin');
  try {
    cfg.komgaJarPath = moveJarToManagedFolder(cfg.komgaJarPath, managedJarDir, true);
  } catch (e) {
    throw new Error(`Failed to move Komga JAR to managed bin folder: ${e.message}`);
  }

  cfg.komgaDataDir = cfg.komgaDataDir || path.join(cfg.dataDir, 'komga');
  cfg.komgaUrl = cfg.komgaUrl || 'http://localhost:25600';
  fs.mkdirSync(cfg.komgaDataDir, { recursive: true });
  saveConfig(cfg);

  const runner = startKomgaJar(cfg.komgaJarPath, {
    javaArgs: cfg.komgaJavaArgs || [],
    appArgs: cfg.komgaAppArgs || [],
    detached: true,
    cwd: cfg.komgaDataDir,
    env: {
      ...process.env,
      KOMGA_CONFIGDIR: cfg.komgaDataDir
    }
  });

  const ready = await waitForKomgaReady(cfg.komgaUrl, 30000, 1000);
  cfg._komgaRunnerPid = runner.proc.pid;
  saveConfig(cfg);
  return { cfg, ready, pid: runner.proc.pid, komgaUrl: cfg.komgaUrl };
}

function buildKomgaAuthHeaders(cfg) {
  if (cfg && cfg.komgaApiKey) {
    return { 'X-API-Key': String(cfg.komgaApiKey) };
  }
  if (cfg && cfg.komgaToken) {
    return { Authorization: `Bearer ${String(cfg.komgaToken)}` };
  }
  return {};
}

function buildKomgaAuthConfig(cfg) {
  const headers = buildKomgaAuthHeaders(cfg);
  const auth = (cfg && cfg.komgaUsername && cfg.komgaPassword)
    ? { username: String(cfg.komgaUsername), password: String(cfg.komgaPassword) }
    : undefined;
  return { headers, auth };
}

async function triggerKomgaLibraryScan(options = {}) {
  const cfg = loadConfig();
  const komgaUrl = cfg.komgaUrl || 'http://localhost:25600';
  const authCfg = buildKomgaAuthConfig(cfg);
  const scanPayload = {
    scanDeep: options.scanDeep !== false,
    scanForceModifiedTime: options.scanForceModifiedTime === true
  };

  const client = axios.create({
    baseURL: komgaUrl,
    timeout: 10000,
    headers: authCfg.headers,
    auth: authCfg.auth,
    validateStatus: () => true
  });

  const listRes = await client.get('/api/v1/libraries');
  if (listRes.status === 401 || listRes.status === 403) {
    throw new Error('Komga auth required for scan. Configure komgaApiKey or komgaUsername/komgaPassword.');
  }

  const libs = Array.isArray(listRes.data)
    ? listRes.data
    : (Array.isArray(listRes.data && listRes.data.content) ? listRes.data.content : []);

  let triggered = 0;
  for (const lib of libs) {
    const id = lib && (lib.id || lib.libraryId);
    if (!id) continue;
    const res = await client.post(`/api/v1/libraries/${encodeURIComponent(String(id))}/scan`, scanPayload);
    if (res.status >= 200 && res.status < 300) triggered += 1;
  }

  if (triggered > 0) {
    return { ok: true, triggered, strategy: 'per-library' };
  }

  const fallback1 = await client.post('/api/v1/libraries/scan', scanPayload);
  if (fallback1.status >= 200 && fallback1.status < 300) {
    return { ok: true, triggered: 1, strategy: 'global-libraries-scan' };
  }

  const fallback2 = await client.post('/api/v1/scan', scanPayload);
  if (fallback2.status >= 200 && fallback2.status < 300) {
    return { ok: true, triggered: 1, strategy: 'global-scan' };
  }

  throw new Error(`Komga scan endpoint not accepted (HTTP ${fallback2.status || fallback1.status || listRes.status}).`);
}

async function triggerKomgaMetadataRefresh() {
  const cfg = loadConfig();
  const komgaUrl = cfg.komgaUrl || 'http://localhost:25600';
  const authCfg = buildKomgaAuthConfig(cfg);

  const client = axios.create({
    baseURL: komgaUrl,
    timeout: 10000,
    headers: authCfg.headers,
    auth: authCfg.auth,
    validateStatus: () => true
  });

  const listRes = await client.get('/api/v1/libraries');
  if (listRes.status === 401 || listRes.status === 403) {
    throw new Error('Komga auth required for metadata refresh.');
  }

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
  if (fallback1.status >= 200 && fallback1.status < 300) {
    return { ok: true, triggered: 1, strategy: 'global-libraries-refresh' };
  }

  const fallback2 = await client.post('/api/v1/metadata/refresh');
  if (fallback2.status >= 200 && fallback2.status < 300) {
    return { ok: true, triggered: 1, strategy: 'global-refresh' };
  }

  throw new Error(`Komga metadata refresh endpoint not accepted (HTTP ${fallback2.status || fallback1.status || listRes.status}).`);
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
  const titles = itemMeta && Array.isArray(itemMeta.altTitles) ? itemMeta.altTitles : [];
  for (const t of titles) {
    const title = String(t || '').trim();
    if (!title) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label: 'anilist', title });
    if (out.length >= 20) break;
  }
  return out;
}

function buildKomgaSeriesMetadataPatch(itemMeta, existingMetadata = null) {
  if (!itemMeta) return null;

  const summary = toEnglishSummaryText(itemMeta);
  const currentSummary = String(existingMetadata && existingMetadata.summary || '').trim();
  const summaryOut = summary || currentSummary || 'Sinopse indisponivel no AniList.';

  const language = itemMeta && itemMeta.countryOfOrigin
    ? ({ JP: 'ja', KR: 'ko', CN: 'zh', TW: 'zh', US: 'en' }[String(itemMeta.countryOfOrigin).toUpperCase()] || '')
    : '';

  const total = Number.isFinite(Number(itemMeta.totalChapters)) ? Number(itemMeta.totalChapters) : null;
  const status = mapKomgaStatusFromAniList(itemMeta.mediaStatus || itemMeta.status);
  const alternateTitles = toKomgaAlternateTitles(itemMeta);
  const genres = Array.isArray(itemMeta.genres)
    ? itemMeta.genres.map(x => String(x || '').trim().toLowerCase()).filter(Boolean).slice(0, 20)
    : [];
  const title = String(itemMeta.title || '').trim();
  const publisher = String(itemMeta.publisher || '').trim();

  const payload = {};
  if (title) {
    payload.title = title;
    payload.titleSort = title;
  }
  if (summaryOut) payload.summary = summaryOut;
  if (language) payload.language = language;
  if (Number.isFinite(total) && total > 0) payload.totalBookCount = total;
  if (status) payload.status = status;
  if (publisher) payload.publisher = publisher;
  if (genres.length) payload.genres = genres;
  if (alternateTitles.length) payload.alternateTitles = alternateTitles;

  return Object.keys(payload).length ? payload : null;
}

async function syncKomgaSeriesMetadataFromLocal(options = {}) {
  const cfg = loadConfig();
  const komgaUrl = cfg.komgaUrl || 'http://localhost:25600';
  const authCfg = buildKomgaAuthConfig(cfg);

  const client = axios.create({
    baseURL: komgaUrl,
    timeout: 10000,
    headers: authCfg.headers,
    auth: authCfg.auth,
    validateStatus: () => true
  });

  const listRes = await client.get('/api/v1/libraries');
  if (!(listRes.status >= 200 && listRes.status < 300)) {
    throw new Error(`Failed to list Komga libraries (HTTP ${listRes.status}).`);
  }

  const libs = Array.isArray(listRes.data)
    ? listRes.data
    : (Array.isArray(listRes.data && listRes.data.content) ? listRes.data.content : []);

  const metadataIndex = buildListMetadataIndex();
  const metadataById = buildListMetadataById();
  const localMetadataIndex = buildSeriesJsonMetadataIndex([
    cfg.downloadsPath || null,
    cfg.komgaLibraryPath || null
  ]);
  const aniListByIdCache = new Map();
  let patched = 0;
  let skipped = 0;
  let attempted = 0;
  let failed = 0;

  for (const lib of libs) {
    const libraryId = lib && (lib.id || lib.libraryId);
    if (!libraryId) continue;

    let page = 0;
    while (true) {
      const res = await client.get('/api/v1/series', {
        params: {
          library_id: String(libraryId),
          page,
          size: 200
        }
      });

      if (!(res.status >= 200 && res.status < 300)) break;

      const content = res.data && Array.isArray(res.data.content)
        ? res.data.content
        : (Array.isArray(res.data) ? res.data : []);
      if (!content.length) break;

      for (const s of content) {
        const seriesName = String((s && (s.name || (s.metadata && s.metadata.title))) || '').trim();
        const seriesDir = s && s.url ? String(s.url) : '';
        const seriesJsonMeta = readSeriesJsonMetadata(seriesDir);

        const fromListByName = findSeriesMetadata(seriesName, metadataIndex);
        const fromLocalByName = findSeriesMetadata(seriesName, localMetadataIndex);
        const idFromSeriesJson = Number(seriesJsonMeta && seriesJsonMeta.id);
        const fromListById = Number.isFinite(idFromSeriesJson) ? metadataById.get(idFromSeriesJson) : null;
        let itemMeta = mergeItemMetadata(fromListById, fromListByName, fromLocalByName, seriesJsonMeta);

        const idCandidate = Number(itemMeta && itemMeta.id);
        const hasDescription = Boolean(itemMeta && String(itemMeta.description || '').trim());
        if (!hasDescription && Number.isFinite(idCandidate) && idCandidate > 0) {
          let fetched = aniListByIdCache.get(idCandidate);
          if (fetched === undefined) {
            try {
              fetched = await fetchAniListMediaById(idCandidate);
            } catch (e) {
              fetched = null;
            }
            aniListByIdCache.set(idCandidate, fetched || null);
          }
          if (fetched) {
            itemMeta = mergeItemMetadata(fetched, itemMeta);
          }
        }

        if (!itemMeta) {
          skipped += 1;
          continue;
        }

        const payload = buildKomgaSeriesMetadataPatch(itemMeta, s && s.metadata ? s.metadata : null);
        if (!payload) {
          skipped += 1;
          continue;
        }

        attempted += 1;
        const r = await client.patch(`/api/v1/series/${encodeURIComponent(String(s.id))}/metadata`, payload);
        if (r.status >= 200 && r.status < 300) {
          patched += 1;
          continue;
        }

        // Fallback payload to maximize compatibility across Komga versions.
        const fallback = {};
        if (payload.summary) fallback.summary = payload.summary;
        if (payload.language) fallback.language = payload.language;
        if (payload.totalBookCount) fallback.totalBookCount = payload.totalBookCount;
        if (payload.status) fallback.status = payload.status;
        if (payload.alternateTitles) fallback.alternateTitles = payload.alternateTitles;

        if (Object.keys(fallback).length === 0) {
          failed += 1;
          continue;
        }

        const r2 = await client.patch(`/api/v1/series/${encodeURIComponent(String(s.id))}/metadata`, fallback);
        if (r2.status >= 200 && r2.status < 300) {
          patched += 1;
        } else {
          failed += 1;
        }
      }

      if (res.data && res.data.last === true) break;
      page += 1;
    }
  }

  return { attempted, patched, skipped, failed };
}

async function ensureKomgaLibraryExists(options = {}) {
  const cfg = loadConfig();
  const komgaUrl = cfg.komgaUrl || 'http://localhost:25600';
  const downloadsRoot = cfg.downloadsPath || (cfg.dataDir ? path.join(cfg.dataDir, 'downloads') : null);
  const root = options.root
    || (cfg.komgaUseDownloadsAsLibrary !== false
      ? downloadsRoot
      : (cfg.komgaLibraryPath || (cfg.dataDir ? path.join(cfg.dataDir, 'komga-library') : null)));
  const name = String(options.name || cfg.komgaAutoLibraryName || 'mangas-Suwayomi').trim() || 'mangas-Suwayomi';

  if (!root) throw new Error('Library root path is not configured for Komga.');

  const authCfg = buildKomgaAuthConfig(cfg);
  const client = axios.create({
    baseURL: komgaUrl,
    timeout: 10000,
    headers: authCfg.headers,
    auth: authCfg.auth,
    validateStatus: () => true
  });

  const listRes = await client.get('/api/v1/libraries');
  if (listRes.status === 401 || listRes.status === 403) {
    throw new Error('Komga auth required to create library. Configure komgaApiKey or komgaUsername/komgaPassword.');
  }
  if (!(listRes.status >= 200 && listRes.status < 300)) {
    throw new Error(`Failed to list Komga libraries (HTTP ${listRes.status}).`);
  }

  const libs = Array.isArray(listRes.data)
    ? listRes.data
    : (Array.isArray(listRes.data && listRes.data.content) ? listRes.data.content : []);

  const normalizedRoot = path.resolve(root);
  const existing = libs.find(lib => {
    const libName = String(lib && (lib.name || '')).trim().toLowerCase();
    const libRoot = String(lib && (lib.root || lib.path || '')).trim();
    if (libName === name.toLowerCase()) return true;
    if (libRoot && path.resolve(libRoot) === normalizedRoot) return true;
    return false;
  });

  if (existing) {
    return {
      created: false,
      name: existing.name || name,
      root: existing.root || root,
      id: existing.id || existing.libraryId || null
    };
  }

  const payload = {
    name,
    root,
    importComicInfoBook: true,
    importComicInfoSeries: true,
    importLocalArtwork: true,
    scanForceModifiedTime: false,
    scanDeep: true
  };

  const createRes = await client.post('/api/v1/libraries', payload);
  if (!(createRes.status >= 200 && createRes.status < 300)) {
    throw new Error(`Failed to create Komga library "${name}" (HTTP ${createRes.status}).`);
  }

  const data = createRes.data || {};
  return {
    created: true,
    name: data.name || name,
    root: data.root || root,
    id: data.id || data.libraryId || null
  };
}

async function fetchUserList(source, username) {
  const rawList = source === 'mal' ? await fetchMAL(username) : await fetchAniList(username);
  const mapped = rawList.map(item => ({ ...item, searchKey: normalize(item.title) }));
  const readingLike = mapped.filter(it => {
    const st = (it.status || '').toLowerCase();
    return st === 'reading' || st === 'paused';
  });

  const listPath = getListPath();
  fs.mkdirSync(path.dirname(listPath), { recursive: true });
  fs.writeFileSync(listPath, JSON.stringify(mapped, null, 2), 'utf8');

  return { mapped, readingLike };
}

function listRepos() {
  const cfg = loadConfig();
  return cfg.extensionRepos || [];
}

function addRepo(url) {
  const cfg = loadConfig();
  cfg.extensionRepos = cfg.extensionRepos || [];
  if (url && !cfg.extensionRepos.includes(url)) {
    cfg.extensionRepos.push(url);
    saveConfig(cfg);
    syncServerConf(cfg);
  }
  return cfg.extensionRepos;
}

function removeRepos(urls) {
  const cfg = loadConfig();
  cfg.extensionRepos = (cfg.extensionRepos || []).filter(r => !urls.includes(r));
  saveConfig(cfg);
  syncServerConf(cfg);
  return cfg.extensionRepos;
}

async function fetchRepoIndexes() {
  const repos = listRepos();
  const out = [];
  for (const repo of repos) {
    try {
      const res = await axios.get(repo, { timeout: 10000 });
      out.push({ repo, ok: true, isArray: Array.isArray(res.data), size: Array.isArray(res.data) ? res.data.length : Object.keys(res.data || {}).length, data: res.data });
    } catch (e) {
      out.push({ repo, ok: false, error: e.message });
    }
  }
  return out;
}

async function getServerExtensions() {
  const cfg = loadConfig();
  const apiUrl = cfg.apiUrl || 'http://localhost:4567';
  const client = makeApiClient(apiUrl);
  return listExtensions(client);
}

async function installPackages(pkgs) {
  const cfg = loadConfig();
  const apiUrl = cfg.apiUrl || 'http://localhost:4567';
  const client = makeApiClient(apiUrl);
  const results = [];
  const extensions = await listExtensions(client);
  const knownPkg = new Set((Array.isArray(extensions) ? extensions : []).map(e => e && e.pkgName).filter(Boolean));

  for (const pkg of pkgs) {
    if (!knownPkg.has(pkg)) {
      results.push({
        pkg,
        ok: false,
        error: 'Package not visible in /extension/list. Restart server after updating extensionRepos.'
      });
      continue;
    }

    try {
      const res = await installExtension(client, pkg);
      const status = Number(res && res.status);
      if (status >= 200 && status < 400) {
        results.push({ pkg, ok: true, status });
      } else {
        results.push({ pkg, ok: false, status: Number.isFinite(status) ? status : null, error: `Install returned HTTP ${Number.isFinite(status) ? status : 'unknown'}` });
      }
    } catch (e) {
      results.push({ pkg, ok: false, error: e.message });
    }
  }

  return results;
}

async function getSources() {
  const cfg = loadConfig();
  const apiUrl = cfg.apiUrl || 'http://localhost:4567';
  const client = makeApiClient(apiUrl);
  return listSources(client);
}

function readListForEnqueue() {
  const listPath = getListPath();
  let raw = [];
  try {
    const txt = fs.existsSync(listPath) ? (fs.readFileSync(listPath, 'utf8') || '[]') : '[]';
    const parsed = JSON.parse(txt);
    raw = Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    raw = [];
  }

  const seen = new Set();
  const deduped = raw.filter(item => {
    const key = `${item.searchKey || item.title || ''}|${item.id || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const isCurrentLikeStatus = (status) => {
    const s = String(status || '').trim().toLowerCase();
    return s === 'current' || s === 'reading' || s === 'rereading';
  };

  const eligible = deduped.filter(item => isCurrentLikeStatus(item.status));
  const skipped = deduped.length - eligible.length;

  return {
    rawCount: raw.length,
    dedupedCount: deduped.length,
    skippedByStatus: skipped,
    list: eligible
  };
}

function getItemProcessKey(item) {
  const src = String(item.source || 'unknown');
  const id = String(item.id || '');
  const sk = String(item.searchKey || normalize(item.title || ''));
  return `${src}:${id}:${sk}`;
}

function loadDownloadsRegistry() {
  const downloadsPath = getDownloadsPath();
  try {
    const txt = fs.readFileSync(downloadsPath, 'utf8') || '{}';
    const data = JSON.parse(txt);
    if (data && typeof data === 'object' && data.items && typeof data.items === 'object') {
      return data;
    }
  } catch (e) {
    // ignore and return default
  }
  return { version: 1, items: {} };
}

function loadLinkCache() {
  const linkCachePath = getLinkCachePath();
  try {
    const txt = fs.readFileSync(linkCachePath, 'utf8') || '{}';
    const data = JSON.parse(txt);
    if (data && typeof data === 'object' && data.items && typeof data.items === 'object') {
      return data;
    }
  } catch (e) {
    // ignore and return default
  }
  return { version: 1, items: {} };
}

function saveLinkCache(cache) {
  const linkCachePath = getLinkCachePath();
  fs.mkdirSync(path.dirname(linkCachePath), { recursive: true });
  fs.writeFileSync(linkCachePath, JSON.stringify(cache, null, 2), 'utf8');
}

function buildLinkCacheSignature(item, options, cfg) {
  const langs = Array.isArray(options.allowedLangs)
    ? options.allowedLangs
    : (Array.isArray(cfg.preferredSearchLangs) ? cfg.preferredSearchLangs : []);
  const maxSourcesToTry = Math.max(1, Number(options.maxSourcesToTry || cfg.maxExtensionsForAutoLink || cfg.maxSourcesToTryForSearch || 12));
  const sourceOrderIds = Array.isArray(options.sourceOrderIds) ? options.sourceOrderIds.map(String) : [];
  return JSON.stringify({
    key: getItemProcessKey(item),
    langs: langs.map(x => String(x || '').toLowerCase()).sort(),
    maxSourcesToTry,
    sourceOrderIds,
    verifyChapters: options.verifyChapters !== false
  });
}

function getCachedAutoLink(item, options, cfg) {
  const cache = loadLinkCache();
  const key = getItemProcessKey(item);
  const entry = cache.items[key];
  if (!entry) return null;
  const signature = buildLinkCacheSignature(item, options, cfg);
  if (entry.signature !== signature) return null;
  const ttlMs = Math.max(10, Number(cfg.linkCacheTtlMinutes || 720)) * 60 * 1000;
  const ageMs = Date.now() - Number(new Date(entry.updatedAt || 0).getTime() || 0);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > ttlMs) return null;
  return entry;
}

function upsertCachedAutoLink(item, options, cfg, data) {
  const cache = loadLinkCache();
  const key = getItemProcessKey(item);
  cache.items[key] = {
    signature: buildLinkCacheSignature(item, options, cfg),
    updatedAt: new Date().toISOString(),
    best: data.best || null,
    sources: Array.isArray(data.sources) ? data.sources : []
  };
  saveLinkCache(cache);
}

function upsertSmartEnqueueReport(item, report) {
  const cache = loadLinkCache();
  if (!cache.reports || typeof cache.reports !== 'object') {
    cache.reports = { items: {}, sources: {} };
  }
  if (!cache.reports.items || typeof cache.reports.items !== 'object') {
    cache.reports.items = {};
  }
  if (!cache.reports.sources || typeof cache.reports.sources !== 'object') {
    cache.reports.sources = {};
  }

  const itemKey = getItemProcessKey(item);
  cache.reports.items[itemKey] = {
    updatedAt: new Date().toISOString(),
    title: item.title || item.searchKey || itemKey,
    attemptsTotal: Number(report && report.attemptsTotal || 0),
    sourceSwitches: Number(report && report.sourceSwitches || 0),
    sourceAttempts: Array.isArray(report && report.sourceAttempts) ? report.sourceAttempts : [],
    warnings: Array.isArray(report && report.warnings) ? report.warnings : []
  };

  const attempts = Array.isArray(report && report.sourceAttempts) ? report.sourceAttempts : [];
  for (const s of attempts) {
    const sourceId = String(s && s.sourceId || '').trim();
    if (!sourceId) continue;
    const cur = cache.reports.sources[sourceId] || {
      sourceId,
      sourceName: s.sourceName || sourceId,
      failures: 0,
      switchesAway: 0,
      lastError: '',
      updatedAt: ''
    };
    const failedAttempts = Number(s && s.failedAttempts || 0);
    cur.failures += failedAttempts;
    if (failedAttempts >= Number(report && report.perSourceRetryMax || 3)) {
      cur.switchesAway += 1;
    }
    if (s && s.lastError) cur.lastError = String(s.lastError);
    cur.updatedAt = new Date().toISOString();
    cache.reports.sources[sourceId] = cur;
  }

  saveLinkCache(cache);
}

function chaptersAreAlreadyCovered(existingRequestedChapters, currentRequestedChapters) {
  const prev = Array.isArray(existingRequestedChapters)
    ? existingRequestedChapters.map(Number).filter(Number.isFinite)
    : [];
  const curr = Array.isArray(currentRequestedChapters)
    ? currentRequestedChapters.map(Number).filter(Number.isFinite)
    : [];

  if (!prev.length || !curr.length) return false;
  const prevSet = new Set(prev);
  return curr.every(ch => prevSet.has(ch));
}

function saveDownloadsRegistry(registry) {
  const downloadsPath = getDownloadsPath();
  fs.mkdirSync(path.dirname(downloadsPath), { recursive: true });
  fs.writeFileSync(downloadsPath, JSON.stringify(registry, null, 2), 'utf8');
}

function buildSearchTermsForItem(item) {
  const terms = [];
  const push = (v) => {
    const s = String(v || '').trim();
    if (!s) return;
    if (!terms.some(x => x.toLowerCase() === s.toLowerCase())) {
      terms.push(s);
    }
  };

  push(item.title);
  (Array.isArray(item.altTitles) ? item.altTitles : []).forEach(push);

  const withoutBrackets = String(item.title || '').replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
  push(withoutBrackets);

  // Keep normalized key only as last-resort fallback.
  push(item.searchKey);

  return terms.slice(0, 6);
}

function normalizeTitleLoose(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isChapterStrictlyBeforeProgress(chapterNumber, progress) {
  const ch = Number(chapterNumber);
  const p = Number(progress);
  if (!Number.isFinite(ch) || !Number.isFinite(p)) return false;
  // Keep current chapter; delete only older chapters (e.g., progress=210 -> delete <=209.x).
  return ch < (p - 0.01);
}

function tokenizeTitleLoose(s) {
  const stop = new Set(['the', 'a', 'an', 'of', 'to', 'and', 'in', 'on', 'no', 'wa', 'ga', 'de', 'ni']);
  return normalizeTitleLoose(s)
    .split(' ')
    .map(x => x.trim())
    .filter(Boolean)
    .filter(x => x.length > 1)
    .filter(x => !stop.has(x));
}

function scoreTwoTitlesForAutoLink(inputTitle, candidateTitle) {
  const a = normalizeTitleLoose(inputTitle);
  const b = normalizeTitleLoose(candidateTitle);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (b.includes(a) || a.includes(b)) return 92;

  const aTokens = tokenizeTitleLoose(a);
  const bTokens = tokenizeTitleLoose(b);
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

function scoreCandidateAgainstItemTitles(item, candidateTitle) {
  const inputs = [];
  const push = (v) => {
    const s = String(v || '').trim();
    if (!s) return;
    if (!inputs.some(x => x.toLowerCase() === s.toLowerCase())) inputs.push(s);
  };

  push(item.title);
  (Array.isArray(item.altTitles) ? item.altTitles : []).forEach(push);
  push(item.searchKey);

  let best = { score: 0, matchedAgainst: '' };
  for (const t of inputs.slice(0, 12)) {
    const score = scoreTwoTitlesForAutoLink(t, candidateTitle);
    if (score > best.score) {
      best = { score, matchedAgainst: t };
    }
  }
  return best;
}

function reorderSourcesByIds(sources, orderedIds = []) {
  if (!Array.isArray(orderedIds) || !orderedIds.length) return sources;
  const pos = new Map(orderedIds.map((id, i) => [String(id), i]));
  return [...sources].sort((a, b) => {
    const pa = pos.has(String(a.id)) ? pos.get(String(a.id)) : Number.MAX_SAFE_INTEGER;
    const pb = pos.has(String(b.id)) ? pos.get(String(b.id)) : Number.MAX_SAFE_INTEGER;
    return pa - pb;
  });
}

function getManualLinks(cfg = null) {
  const cache = loadLinkCache();
  if (!cache.manualLinks || typeof cache.manualLinks !== 'object') {
    cache.manualLinks = {};
  }

  if (Object.keys(cache.manualLinks).length > 0) {
    return cache.manualLinks;
  }

  // Backward compatibility: migrate legacy manualLinks from config.json once.
  const c = cfg || loadConfig();
  const legacy = c && c.manualLinks && typeof c.manualLinks === 'object'
    ? c.manualLinks
    : {};
  if (Object.keys(legacy).length > 0) {
    cache.manualLinks = legacy;
    saveLinkCache(cache);
    return cache.manualLinks;
  }

  return cache.manualLinks;
}

function setManualLink(item, link) {
  const key = getItemProcessKey(item);
  const cache = loadLinkCache();
  cache.manualLinks = getManualLinks();
  cache.manualLinks[key] = {
    sourceId: String(link.sourceId),
    sourceName: link.sourceName || '',
    mangaId: Number(link.mangaId),
    mangaTitle: link.mangaTitle || item.title || '',
    updatedAt: new Date().toISOString()
  };
  saveLinkCache(cache);
  return cache.manualLinks[key];
}

function removeManualLink(item) {
  const key = getItemProcessKey(item);
  const cache = loadLinkCache();
  const links = getManualLinks();
  if (links[key]) {
    delete links[key];
    cache.manualLinks = links;
    saveLinkCache(cache);
  }
  return true;
}

function listMangaItemsForManualLink(limit = 300) {
  const prepared = readListForEnqueue();
  const cfg = loadConfig();
  const links = getManualLinks(cfg);
  return prepared.list.slice(0, limit).map(item => {
    const key = getItemProcessKey(item);
    return {
      key,
      item,
      linked: links[key] || null
    };
  });
}

async function searchManualLinkCandidates(item, sourceId, query) {
  const cfg = loadConfig();
  const apiUrl = cfg.apiUrl || 'http://localhost:4567';
  const client = makeApiClient(apiUrl);
  const term = String(query || item.title || item.searchKey || '').trim();
  if (!term) return [];

  const page = await searchSource(client, sourceId, term, 1);
  const mangaList = Array.isArray(page && page.mangaList) ? page.mangaList : [];
  return mangaList.slice(0, 30).map(m => ({
    id: Number(m.id),
    title: m.title || `manga:${m.id}`
  }));
}

async function getManualLinkRuntimeStatus(item) {
  const cfg = loadConfig();
  const key = getItemProcessKey(item);
  const links = getManualLinks(cfg);
  const linked = links[key] || null;

  if (!linked) {
    return {
      linked: null,
      ok: true,
      hasChapters: null,
      downloadedCount: 0,
      chapterCount: 0,
      maxDownloaded: 0
    };
  }

  const apiUrl = cfg.apiUrl || 'http://localhost:4567';
  const client = makeApiClient(apiUrl, { timeout: Math.max(5000, Number(cfg.apiTimeoutMs || 30000)) });
  const mangaId = Number(linked.mangaId);

  if (!Number.isFinite(mangaId)) {
    return {
      linked,
      ok: false,
      error: 'mangaId invalido no vinculo manual',
      hasChapters: null,
      downloadedCount: 0,
      chapterCount: 0,
      maxDownloaded: 0
    };
  }

  try {
    const chapters = await getMangaChapters(client, mangaId, true);
    const list = Array.isArray(chapters) ? chapters : [];
    const downloadedNumbers = list
      .filter(ch => Boolean(ch && ch.downloaded))
      .map(ch => Number(ch.chapterNumber))
      .filter(Number.isFinite);

    return {
      linked,
      ok: true,
      hasChapters: list.some(ch => Number.isFinite(Number(ch && ch.index))),
      downloadedCount: list.filter(ch => Boolean(ch && ch.downloaded)).length,
      chapterCount: list.length,
      maxDownloaded: downloadedNumbers.length ? Math.max(...downloadedNumbers) : 0
    };
  } catch (e) {
    return {
      linked,
      ok: false,
      error: e.message,
      hasChapters: null,
      downloadedCount: 0,
      chapterCount: 0,
      maxDownloaded: 0
    };
  }
}

async function mangaHasChapters(apiClient, mangaId) {
  const id = Number(mangaId);
  if (!Number.isFinite(id)) return null;
  try {
    const chapters = await getMangaChapters(apiClient, id, true);
    if (!Array.isArray(chapters) || !chapters.length) return false;
    return chapters.some(ch => Number.isFinite(Number(ch && ch.index)));
  } catch (e) {
    return null;
  }
}

async function getAutoLinkCandidates(item, options = {}) {
  const cfg = loadConfig();
  const apiUrl = cfg.apiUrl || 'http://localhost:4567';
  const client = makeApiClient(apiUrl, { timeout: Math.max(5000, Number(cfg.apiTimeoutMs || 30000)) });

  const useCache = options.useCache !== false;
  const forceRefresh = Boolean(options.forceRefresh);
  if (useCache && !forceRefresh) {
    const cached = getCachedAutoLink(item, options, cfg);
    if (cached) {
      return {
        item,
        best: cached.best || null,
        sources: Array.isArray(cached.sources) ? cached.sources : [],
        cached: true
      };
    }
  }

  const rawSources = await listSources(client);
  if (!Array.isArray(rawSources) || !rawSources.length) {
    return { item, best: null, sources: [] };
  }

  const defaultLangs = Array.isArray(cfg.preferredSearchLangs) ? cfg.preferredSearchLangs : [];
  const allowedLangs = Array.isArray(options.allowedLangs) ? options.allowedLangs : defaultLangs;
  const langSet = new Set(allowedLangs.map(x => String(x || '').toLowerCase()).filter(Boolean));

  let sources = rawSources;
  if (langSet.size > 0) {
    sources = rawSources.filter(s => langSet.has(String(s.lang || '').toLowerCase()));
  }

  const ordered = reorderSourcesByIds(sources, Array.isArray(options.sourceOrderIds) ? options.sourceOrderIds : []);
  const maxSourcesToTry = Math.max(1, Number(options.maxSourcesToTry || cfg.maxExtensionsForAutoLink || 12));
  const searchTerms = buildSearchTermsForItem(item);
  const verifyChapters = options.verifyChapters !== false;
  const sourceConcurrency = Math.max(1, Math.min(40, Number(options.searchConcurrency || cfg.maxSourcesInParallel || 8)));

  const selectedSources = ordered.slice(0, maxSourcesToTry);
  const bySourceRaw = [];
  let cursor = 0;

  async function worker() {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= selectedSources.length) return;

      const source = selectedSources[idx];
      const seen = new Set();
      const ranked = [];

      for (const term of searchTerms) {
        try {
          const page = await searchSource(client, source.id, term, 1);
          const mangaList = Array.isArray(page && page.mangaList) ? page.mangaList : [];
          for (const manga of mangaList) {
            const id = Number(manga && manga.id);
            if (!Number.isFinite(id) || seen.has(id)) continue;
            seen.add(id);

            const title = String((manga && manga.title) || `manga:${id}`);
            const scored = scoreCandidateAgainstItemTitles(item, title);
            ranked.push({ id, title, score: scored.score, matchedAgainst: scored.matchedAgainst, term });
          }
        } catch (e) {
          // ignore this term/source failure in preview mode
        }
      }

      ranked.sort((x, y) => y.score - x.score);
      let top = ranked.slice(0, 5).map(x => ({ ...x, hasChapters: null }));
      if (verifyChapters && top.length) {
        const checks = await Promise.all(
          top.slice(0, 3).map(async c => ({ id: c.id, ok: await mangaHasChapters(client, c.id) }))
        );
        const map = new Map(checks.map(x => [Number(x.id), x.ok]));
        top = top.map(c => ({ ...c, hasChapters: map.has(Number(c.id)) ? map.get(Number(c.id)) : null }));

        const hasAnyWithChapters = top.some(c => c.hasChapters === true);
        if (hasAnyWithChapters) {
          top.sort((a, b) => {
            const ah = a.hasChapters === true ? 1 : 0;
            const bh = b.hasChapters === true ? 1 : 0;
            if (ah !== bh) return bh - ah;
            return Number(b.score || 0) - Number(a.score || 0);
          });
        }
      }

      if (top.length) {
        bySourceRaw.push({
          idx,
          sourceId: String(source.id),
          sourceName: source.name || String(source.id),
          lang: source.lang || '',
          mangas: top
        });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(sourceConcurrency, selectedSources.length || 1) }, () => worker()));
  bySourceRaw.sort((a, b) => a.idx - b.idx);
  const bySource = bySourceRaw.map(({ idx, ...rest }) => rest);

  let best = null;
  for (const src of bySource) {
    const candidate = Array.isArray(src.mangas) && src.mangas[0] ? src.mangas[0] : null;
    if (!candidate) continue;
    if (!best || Number(candidate.score || 0) > Number(best.score || 0)) {
      best = {
        sourceId: String(src.sourceId),
        sourceName: src.sourceName || String(src.sourceId),
        mangaId: Number(candidate.id),
        mangaTitle: candidate.title,
        score: Number(candidate.score || 0),
        matchedAgainst: candidate.matchedAgainst || ''
      };
    }
  }

  if (!best || !best.sourceId || !Number.isFinite(Number(best.mangaId))) {
    const first = bySource[0] && Array.isArray(bySource[0].mangas) ? bySource[0].mangas[0] : null;
    if (first) {
      best = {
        sourceId: bySource[0].sourceId,
        sourceName: bySource[0].sourceName,
        mangaId: Number(first.id),
        mangaTitle: first.title,
        score: Number(first.score || 0),
        matchedAgainst: first.matchedAgainst || ''
      };
    }
  }

  const result = {
    item,
    best,
    sources: bySource,
    cached: false
  };

  if (useCache) {
    upsertCachedAutoLink(item, options, cfg, result);
  }

  return result;
}

function getCachedAutoLinkCandidates(item, options = {}) {
  const cfg = loadConfig();
  const cached = getCachedAutoLink(item, options, cfg);
  return {
    item,
    best: cached && cached.best ? cached.best : null,
    sources: cached && Array.isArray(cached.sources) ? cached.sources : [],
    cached: Boolean(cached)
  };
}

function isHttpStatus(err, code) {
  const status = Number(err && err.response && err.response.status);
  if (Number.isFinite(status)) return status === Number(code);
  const msg = String((err && err.message) || '');
  return msg.includes(`status code ${Number(code)}`);
}

function isTimeoutError(err) {
  const msg = String((err && err.message) || '').toLowerCase();
  const code = String((err && err.code) || '').toUpperCase();
  return code === 'ECONNABORTED' || msg.includes('timeout');
}

function collectFallbackFixedMatches(preview, ignoreSet = new Set()) {
  const out = [];
  const seen = new Set();
  const sources = Array.isArray(preview && preview.sources) ? preview.sources : [];

  for (const src of sources) {
    const mangas = Array.isArray(src && src.mangas) ? src.mangas : [];
    for (const m of mangas.slice(0, 3)) {
      const sourceId = String(src.sourceId || '');
      const mangaId = Number(m && m.id);
      if (!sourceId || !Number.isFinite(mangaId)) continue;
      const key = `${sourceId}:${mangaId}`;
      if (seen.has(key) || ignoreSet.has(key)) continue;
      seen.add(key);
      out.push({
        sourceId,
        sourceName: src.sourceName || sourceId,
        mangaId,
        mangaTitle: String((m && m.title) || ''),
        score: Number((m && m.score) || 0),
        hasChapters: m && m.hasChapters
      });
    }
  }

  // Prefer candidates with chapter signal when available.
  out.sort((a, b) => {
    const ah = a.hasChapters === true ? 1 : 0;
    const bh = b.hasChapters === true ? 1 : 0;
    if (ah !== bh) return bh - ah;
    return Number(b.score || 0) - Number(a.score || 0);
  });

  return out.slice(0, 8);
}

async function tryFixedMatchWithRetries(client, item, chapters, priority, base, fixedMatch, retriesPerSource) {
  const attempts = [];
  let lastErr = null;

  for (let i = 1; i <= retriesPerSource; i += 1) {
    try {
      const result = await searchAndEnqueue(
        client,
        item.title || item.searchKey,
        chapters,
        priority || [],
        {
          sources: base.sources,
          maxSourcesToTry: Number(base.maxSourcesToTry || base.sources.length || 25),
          searchTerms: base.searchTerms,
          fixedMatch,
          strictTitleMatch: base.strictTitleMatch !== false,
          strictMinScore: Number(base.strictMinScore || 88)
        }
      );
      attempts.push({ attempt: i, ok: true });
      return { ok: true, result, attempts };
    } catch (e) {
      lastErr = e;
      attempts.push({ attempt: i, ok: false, error: String(e && e.message || 'unknown-error') });
      if (i < retriesPerSource && isTimeoutError(e)) {
        await sleep(Math.min(2500, 500 * i));
      }
    }
  }

  return { ok: false, error: lastErr, attempts };
}

async function runSmartEnqueueFlow(client, item, chapters, priority, context) {
  const retriesPerSource = Math.max(1, Math.min(5, Number(context.cfg.enqueueRetryAttempts || 3)));
  const report = {
    attemptsTotal: 0,
    sourceSwitches: 0,
    perSourceRetryMax: retriesPerSource,
    sourceAttempts: [],
    warnings: []
  };

  const linked = context.currentFixedMatch || null;
  const base = {
    sources: context.sources,
    maxSourcesToTry: Number(context.cfg.maxSourcesToTryForSearch || context.sources.length || 25),
    searchTerms: context.searchTerms,
    strictTitleMatch: context.cfg.strictTitleMatch !== false,
    strictMinScore: Number(context.cfg.strictMinScore || 88)
  };

  if (linked && linked.sourceId != null && linked.mangaId != null) {
    const primary = await tryFixedMatchWithRetries(client, item, chapters, priority || [], base, linked, retriesPerSource);
    report.attemptsTotal += primary.attempts.length;
    report.sourceAttempts.push({
      sourceId: String(linked.sourceId),
      sourceName: linked.sourceName || String(linked.sourceId),
      mangaId: Number(linked.mangaId),
      mangaTitle: linked.mangaTitle || item.title || '',
      failedAttempts: primary.attempts.filter(a => !a.ok).length,
      attempts: primary.attempts,
      lastError: primary.error ? String(primary.error.message || primary.error) : ''
    });

    if (primary.ok) {
      return { ok: true, result: primary.result, report };
    }

    report.warnings.push(`Fonte ${linked.sourceName || linked.sourceId} falhou ${retriesPerSource}x; pode estar com defeito.`);

    const preview = await getAutoLinkCandidates(item, {
      maxSourcesToTry: Number(context.cfg.maxExtensionsForAutoLink || context.cfg.maxSourcesToTryForSearch || 12),
      sourceOrderIds: context.sourceOrderIds || [],
      allowedLangs: context.allowedLangs || [],
      forceRefresh: true,
      useCache: true,
      verifyChapters: true
    });
    const ignore = new Set([`${String(linked.sourceId)}:${Number(linked.mangaId)}`]);
    const fallbackMatches = collectFallbackFixedMatches(preview, ignore);

    for (const fixed of fallbackMatches) {
      report.sourceSwitches += 1;
      const tried = await tryFixedMatchWithRetries(client, item, chapters, priority || [], base, fixed, retriesPerSource);
      report.attemptsTotal += tried.attempts.length;
      report.sourceAttempts.push({
        sourceId: String(fixed.sourceId),
        sourceName: fixed.sourceName || String(fixed.sourceId),
        mangaId: Number(fixed.mangaId),
        mangaTitle: fixed.mangaTitle || '',
        failedAttempts: tried.attempts.filter(a => !a.ok).length,
        attempts: tried.attempts,
        lastError: tried.error ? String(tried.error.message || tried.error) : ''
      });

      if (tried.ok) {
        return {
          ok: true,
          result: {
            ...tried.result,
            fallbackUsed: true,
            fallbackSourceName: fixed.sourceName,
            fallbackMangaTitle: fixed.mangaTitle
          },
          report
        };
      }

      report.warnings.push(`Fonte alternativa ${fixed.sourceName || fixed.sourceId} tambem falhou ${retriesPerSource}x.`);
    }

    const err = new Error(`Todas as fontes tentadas falharam (${report.sourceAttempts.length} fontes, ${report.attemptsTotal} tentativas).`);
    err.code = 'SOURCE_RETRY_EXHAUSTED';
    err.report = report;
    return { ok: false, error: err, report };
  }

  // Sem vinculo fixo: mantem comportamento original, com retry simples.
  let lastErr = null;
  for (let i = 1; i <= retriesPerSource; i += 1) {
    try {
      const result = await searchAndEnqueue(
        client,
        item.title || item.searchKey,
        chapters,
        priority || [],
        {
          sources: base.sources,
          maxSourcesToTry: base.maxSourcesToTry,
          searchTerms: base.searchTerms,
          fixedMatch: null,
          strictTitleMatch: base.strictTitleMatch,
          strictMinScore: base.strictMinScore
        }
      );
      report.attemptsTotal += i;
      report.sourceAttempts.push({
        sourceId: '',
        sourceName: 'auto',
        failedAttempts: i - 1,
        attempts: Array.from({ length: i }, (_, idx) => ({ attempt: idx + 1, ok: idx + 1 === i, error: idx + 1 === i ? '' : 'retry' })),
        lastError: ''
      });
      return { ok: true, result, report };
    } catch (e) {
      lastErr = e;
      report.attemptsTotal += 1;
      if (i < retriesPerSource && isTimeoutError(e)) {
        await sleep(Math.min(2500, 500 * i));
      }
    }
  }
  const err = lastErr || new Error('enqueue-failed');
  err.report = report;
  return { ok: false, error: err, report };
}

async function tryFallbackEnqueueAfter500(client, item, chapters, priority, options) {
  const cfg = options.cfg || loadConfig();
  const ignoreSet = new Set();
  if (options.currentFixedMatch && options.currentFixedMatch.sourceId != null && options.currentFixedMatch.mangaId != null) {
    ignoreSet.add(`${String(options.currentFixedMatch.sourceId)}:${Number(options.currentFixedMatch.mangaId)}`);
  }

  const preview = await getAutoLinkCandidates(item, {
    maxSourcesToTry: Number(cfg.maxExtensionsForAutoLink || cfg.maxSourcesToTryForSearch || 12),
    sourceOrderIds: options.sourceOrderIds || [],
    allowedLangs: options.allowedLangs || [],
    forceRefresh: true,
    useCache: true,
    verifyChapters: true
  });

  const fallbackMatches = collectFallbackFixedMatches(preview, ignoreSet);
  const attempts = [];

  for (const fixed of fallbackMatches) {
    try {
      const result = await searchAndEnqueue(
        client,
        item.title || item.searchKey,
        chapters,
        priority || [],
        {
          sources: options.sources,
          maxSourcesToTry: Number(cfg.maxSourcesToTryForSearch || options.sources.length || 25),
          searchTerms: options.searchTerms,
          fixedMatch: fixed,
          strictTitleMatch: cfg.strictTitleMatch !== false,
          strictMinScore: Number(cfg.strictMinScore || 88)
        }
      );
      return { ok: true, result, fixed, attempts };
    } catch (e) {
      attempts.push({ fixed, error: String(e && e.message || 'unknown-error') });
    }
  }

  return { ok: false, attempts };
}

async function cleanupLibraryDuplicatesForItem(client, item, keepMatch, options = {}) {
  if (!keepMatch || keepMatch.sourceId == null || keepMatch.mangaId == null) {
    return { attempted: 0, removed: 0, failed: 0 };
  }

  const keepKey = `${String(keepMatch.sourceId)}:${Number(keepMatch.mangaId)}`;
  const preview = await getAutoLinkCandidates(item, {
    maxSourcesToTry: Number(options.maxSourcesToTry || 12),
    sourceOrderIds: Array.isArray(options.sourceOrderIds) ? options.sourceOrderIds : [],
    allowedLangs: Array.isArray(options.allowedLangs) ? options.allowedLangs : [],
    forceRefresh: Boolean(options.forceRefresh),
    useCache: true,
    verifyChapters: true
  });

  const candidates = collectFallbackFixedMatches(preview).filter(x => {
    const key = `${String(x.sourceId)}:${Number(x.mangaId)}`;
    return key !== keepKey;
  });

  let removed = 0;
  let failed = 0;
  for (const c of candidates) {
    try {
      const ok = await removeMangaFromLibrary(client, Number(c.mangaId));
      if (ok) removed += 1;
    } catch (e) {
      failed += 1;
    }
  }

  return {
    attempted: candidates.length,
    removed,
    failed
  };
}

async function enqueueFromList({ dry, priority, limit = 200, allowedLangs = [], sourceOrderIds = [], itemKeysFilter = [], onItem = null }) {
  const cfg = loadConfig();
  const apiUrl = cfg.apiUrl || 'http://localhost:4567';
  const timeoutMs = Math.max(5000, Number(cfg.apiTimeoutMs || 30000));
  const client = makeApiClient(apiUrl, { timeout: timeoutMs });
  const capsAhead = cfg.capsAhead || 5;

  const rawSources = await listSources(client);
  if (!Array.isArray(rawSources) || !rawSources.length) {
    throw new Error('No sources available in server. Install extensions first.');
  }

  const effectiveLangs = (allowedLangs && allowedLangs.length)
    ? allowedLangs
    : (Array.isArray(cfg.preferredSearchLangs) ? cfg.preferredSearchLangs : []);
  const langSet = new Set((effectiveLangs || []).map(x => String(x || '').toLowerCase()).filter(Boolean));
  let sources = rawSources;
  if (langSet.size > 0) {
    sources = rawSources.filter(s => langSet.has(String(s.lang || '').toLowerCase()));
  }

  if (cfg.fixedSourceId != null && String(cfg.fixedSourceId).trim() !== '') {
    const sourceId = String(cfg.fixedSourceId).trim();
    sources = sources.filter(s => String(s.id) === sourceId);
  }

  sources = reorderSourcesByIds(sources, sourceOrderIds);
  if (!sources.length) {
    // Avoid hard-stop when filters remove every source; fallback keeps queue functional.
    sources = reorderSourcesByIds(rawSources, sourceOrderIds);
    if (!sources.length) {
      throw new Error('No sources left after language/source-order filters.');
    }
  }

  const priorityList = (priority || []).map(s => String(s || '').toLowerCase()).filter(Boolean);
  if (priorityList.length) {
    const matched = sources.filter(s => {
      const hay = `${s.name || ''} ${s.displayName || ''} ${s.baseUrl || ''} ${s.lang || ''}`.toLowerCase();
      return priorityList.some(p => hay.includes(p));
    });
    if (!matched.length) {
      throw new Error(`No installed source matches your priority list: ${priority.join(', ')}`);
    }
  }

  const prepared = readListForEnqueue();
  const list = prepared.list;
  const keyFilter = new Set((itemKeysFilter || []).map(x => String(x || '')).filter(Boolean));
  let selected = list;
  if (keyFilter.size > 0) {
    selected = list.filter(item => keyFilter.has(getItemProcessKey(item)));
  }
  const toProcess = selected.slice(0, limit);
  if (!toProcess.length) {
    throw new Error('No eligible mangas with CURRENT/reading status found in data/list.json');
  }
  const output = [];
  const registry = loadDownloadsRegistry();
  const manualLinks = getManualLinks(cfg);
  let skippedAlreadyProcessed = 0;
  const notFound = [];

  for (const item of toProcess) {
    const chapters = buildWantedChapterNumbers(item.progress || 0, capsAhead);

    const itemKey = getItemProcessKey(item);
    const linked = manualLinks[itemKey] || null;

    if (dry) {
      const row = { item, chapters, dry: true };
      output.push(row);
      if (onItem) onItem(row);
      continue;
    }

    try {
      const searchTerms = buildSearchTermsForItem(item);
      const smart = await runSmartEnqueueFlow(client, item, chapters, priority || [], {
        cfg,
        sources,
        searchTerms,
        currentFixedMatch: linked,
        sourceOrderIds,
        allowedLangs
      });
      upsertSmartEnqueueReport(item, smart.report);
      if (!smart.ok) {
        throw smart.error;
      }
      const result = smart.result;

      if (cfg.persistSwitchedSourceLink !== false && result && result.fallbackUsed && result.source && result.manga) {
        const prev = linked || null;
        const nextLink = setManualLink(item, {
          sourceId: String(result.source.id),
          sourceName: result.source.name || String(result.source.id),
          mangaId: Number(result.manga.id),
          mangaTitle: result.manga.title || item.title || ''
        });
        result.linkUpdated = true;
        result.previousLink = prev;
        result.currentLink = nextLink;
      }

      if (result && result.alreadyQueuedOrDownloaded) {
        if (cfg.cleanupLibraryDuplicates !== false) {
          const dedupe = await cleanupLibraryDuplicatesForItem(client, item, {
            sourceId: result.source && result.source.id,
            mangaId: result.manga && result.manga.id
          }, {
            maxSourcesToTry: Number(cfg.maxExtensionsForAutoLink || cfg.maxSourcesToTryForSearch || 12),
            sourceOrderIds,
            allowedLangs,
            forceRefresh: false
          });
          result.libraryCleanup = dedupe;
        }

        skippedAlreadyProcessed += 1;
        registry.items[itemKey] = {
          status: 'covered',
          lastCheckedAt: new Date().toISOString(),
          source: item.source,
          id: item.id,
          title: item.title,
          searchKey: item.searchKey,
          matchedSourceId: result.source && result.source.id,
          matchedSourceName: result.source && result.source.name,
          matchedMangaId: result.manga && result.manga.id,
          matchedMangaTitle: result.manga && result.manga.title,
          requestedChapters: chapters,
          queuedChapterIndexes: [],
          enqueueMeta: {
            attemptsTotal: Number(smart.report && smart.report.attemptsTotal || 0),
            sourceSwitches: Number(smart.report && smart.report.sourceSwitches || 0),
            warnings: Array.isArray(smart.report && smart.report.warnings) ? smart.report.warnings : [],
            sourceAttempts: Array.isArray(smart.report && smart.report.sourceAttempts) ? smart.report.sourceAttempts : []
          }
        };
        saveDownloadsRegistry(registry);

        const row = {
          item,
          chapters,
          skipped: true,
          reason: 'already-downloaded-or-queued',
          result
        };
        output.push(row);
        if (onItem) onItem(row);
        continue;
      }

      registry.items[itemKey] = {
        status: 'queued',
        queuedAt: new Date().toISOString(),
        source: item.source,
        id: item.id,
        title: item.title,
        searchKey: item.searchKey,
        matchedSourceId: result.source && result.source.id,
        matchedSourceName: result.source && result.source.name,
        matchedMangaId: result.manga && result.manga.id,
        matchedMangaTitle: result.manga && result.manga.title,
        requestedChapters: chapters,
        queuedChapterIndexes: result.queuedChapterIndexes,
        enqueueMeta: {
          attemptsTotal: Number(smart.report && smart.report.attemptsTotal || 0),
          sourceSwitches: Number(smart.report && smart.report.sourceSwitches || 0),
          warnings: Array.isArray(smart.report && smart.report.warnings) ? smart.report.warnings : [],
          sourceAttempts: Array.isArray(smart.report && smart.report.sourceAttempts) ? smart.report.sourceAttempts : []
        }
      };
      saveDownloadsRegistry(registry);

      if (cfg.cleanupLibraryDuplicates !== false) {
        const dedupe = await cleanupLibraryDuplicatesForItem(client, item, {
          sourceId: result.source && result.source.id,
          mangaId: result.manga && result.manga.id
        }, {
          maxSourcesToTry: Number(cfg.maxExtensionsForAutoLink || cfg.maxSourcesToTryForSearch || 12),
          sourceOrderIds,
          allowedLangs,
          forceRefresh: false
        });
        result.libraryCleanup = dedupe;
      }

      const row = { item, chapters, ok: true, result };
      output.push(row);
      if (onItem) onItem(row);
    } catch (e) {
      registry.items[itemKey] = {
        status: 'failed',
        failedAt: new Date().toISOString(),
        source: item.source,
        id: item.id,
        title: item.title,
        searchKey: item.searchKey,
        error: e.message,
        enqueueMeta: e && e.report ? {
          attemptsTotal: Number(e.report.attemptsTotal || 0),
          sourceSwitches: Number(e.report.sourceSwitches || 0),
          warnings: Array.isArray(e.report.warnings) ? e.report.warnings : [],
          sourceAttempts: Array.isArray(e.report.sourceAttempts) ? e.report.sourceAttempts : []
        } : null
      };
      if (e && e.report) {
        upsertSmartEnqueueReport(item, e.report);
      }
      const row = {
        item,
        chapters,
        ok: false,
        error: e.message,
        noMatch: e && e.code === 'NO_MATCH' ? (e.details || null) : null
      };
      if (row.noMatch) {
        notFound.push({
          title: item.title,
          searchKey: item.searchKey,
          details: row.noMatch
        });
      }
      output.push(row);
      if (onItem) onItem(row);
    }
  }

  if (!dry) saveDownloadsRegistry(registry);

  return {
    sourcesCount: sources.length,
    output,
    stats: {
      rawCount: prepared.rawCount,
      dedupedCount: prepared.dedupedCount,
      skippedByStatus: prepared.skippedByStatus,
      eligibleCount: list.length,
      selectedCount: selected.length,
      processedCount: toProcess.length,
      skippedAlreadyProcessed
    },
    notFound
  };
}

async function buildBatchAutoLinkPreview(options = {}) {
  const onlyUnlinked = options.onlyUnlinked !== false;
  const limit = Math.max(1, Number(options.limit || 50));
  const concurrency = Math.max(1, Math.min(20, Number(options.concurrency || 6)));
  const maxSourcesToTry = Math.max(1, Number(options.maxSourcesToTry || 12));

  const rows = listMangaItemsForManualLink(Math.max(300, limit * 2));
  const queue = (onlyUnlinked ? rows.filter(r => !r.linked) : rows).slice(0, limit);

  const out = [];
  let cursor = 0;

  async function worker() {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= queue.length) return;

      const row = queue[idx];
      try {
        const preview = options.cacheOnly
          ? getCachedAutoLinkCandidates(row.item, {
            maxSourcesToTry,
            verifyChapters: options.verifyChapters !== false
          })
          : await getAutoLinkCandidates(row.item, {
            maxSourcesToTry,
            useCache: options.useCache !== false,
            forceRefresh: Boolean(options.forceRefresh),
            searchConcurrency: Number(options.searchConcurrency || 0) || undefined,
            verifyChapters: options.verifyChapters !== false
          });
        out[idx] = {
          key: row.key,
          item: row.item,
          linked: row.linked || null,
          best: preview.best || null,
          sources: Array.isArray(preview.sources) ? preview.sources : [],
          cached: Boolean(preview.cached)
        };
      } catch (e) {
        out[idx] = {
          key: row.key,
          item: row.item,
          linked: row.linked || null,
          best: null,
          sources: [],
          error: e.message
        };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, () => worker()));
  return out.filter(Boolean);
}

async function warmAutoLinkCache(options = {}) {
  const onlyUnlinked = options.onlyUnlinked !== false;
  const limit = Math.max(1, Number(options.limit || 200));
  const concurrency = Math.max(1, Math.min(20, Number(options.concurrency || 8)));
  const maxSourcesToTry = Math.max(1, Number(options.maxSourcesToTry || 12));
  const forceRefresh = Boolean(options.forceRefresh);

  const rows = listMangaItemsForManualLink(Math.max(300, limit));
  const queue = (onlyUnlinked ? rows.filter(r => !r.linked) : rows).slice(0, limit);

  let cursor = 0;
  let done = 0;
  let withBest = 0;
  let errors = 0;
  let cacheHits = 0;

  async function worker() {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= queue.length) return;
      const row = queue[idx];
      try {
        const preview = options.cacheOnly
          ? getCachedAutoLinkCandidates(row.item, {
            maxSourcesToTry,
            verifyChapters: options.verifyChapters !== false
          })
          : await getAutoLinkCandidates(row.item, {
            maxSourcesToTry,
            useCache: true,
            forceRefresh,
            searchConcurrency: Number(options.searchConcurrency || 0) || undefined,
            verifyChapters: options.verifyChapters !== false
          });
        done += 1;
        if (preview.best) withBest += 1;
        if (preview.cached) cacheHits += 1;
        if (typeof options.onProgress === 'function') {
          options.onProgress({ total: queue.length, done, withBest, errors, cacheHits });
        }
      } catch (e) {
        done += 1;
        errors += 1;
        if (typeof options.onProgress === 'function') {
          options.onProgress({ total: queue.length, done, withBest, errors, cacheHits });
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, () => worker()));
  return {
    total: queue.length,
    done,
    withBest,
    errors,
    cacheHits
  };
}

async function checkSourcesHealth(options = {}) {
  const cfg = loadConfig();
  const apiUrl = cfg.apiUrl || 'http://localhost:4567';
  const timeout = Math.max(2000, Number(options.timeoutMs || 10000));
  const client = makeApiClient(apiUrl, { timeout });
  const probeTerm = String(options.probeTerm || 'one piece');

  const rawSources = await listSources(client);
  if (!Array.isArray(rawSources) || !rawSources.length) {
    return { total: 0, ok: 0, failed: 0, rows: [] };
  }

  const langs = Array.isArray(options.allowedLangs) && options.allowedLangs.length
    ? options.allowedLangs
    : (Array.isArray(cfg.preferredSearchLangs) ? cfg.preferredSearchLangs : []);
  const langSet = new Set(langs.map(x => String(x || '').toLowerCase()).filter(Boolean));
  let sources = rawSources;
  if (langSet.size > 0) {
    sources = rawSources.filter(s => langSet.has(String(s.lang || '').toLowerCase()));
  }

  const maxSourcesToTry = Math.max(1, Number(options.maxSourcesToTry || cfg.maxExtensionsForAutoLink || 12));
  const rows = [];
  for (const source of sources.slice(0, maxSourcesToTry)) {
    try {
      const page = await searchSource(client, source.id, probeTerm, 1);
      const count = Array.isArray(page && page.mangaList) ? page.mangaList.length : 0;
      rows.push({
        sourceId: String(source.id),
        sourceName: source.name || String(source.id),
        lang: source.lang || '',
        ok: true,
        httpStatus: 200,
        sampleResults: count
      });
    } catch (e) {
      const status = Number(e && e.response && e.response.status);
      rows.push({
        sourceId: String(source.id),
        sourceName: source.name || String(source.id),
        lang: source.lang || '',
        ok: false,
        httpStatus: Number.isFinite(status) ? status : null,
        error: e && e.message ? e.message : 'unknown-error'
      });
    }
  }

  const ok = rows.filter(r => r.ok).length;
  const failed = rows.length - ok;
  return {
    total: rows.length,
    ok,
    failed,
    rows
  };
}

async function deleteReadChaptersByAniList(options = {}) {
  const cfg = loadConfig();
  const apiUrl = cfg.apiUrl || 'http://localhost:4567';
  const client = makeApiClient(apiUrl, { timeout: Math.max(5000, Number(cfg.apiTimeoutMs || 30000)) });
  const dry = Boolean(options.dry);
  const limit = Math.max(1, Number(options.limit || 200));

  const prepared = readListForEnqueue();
  const rows = prepared.list.slice(0, limit);
  const manualLinks = getManualLinks(cfg);
  const registry = loadDownloadsRegistry();
  const output = [];

  for (const item of rows) {
    const progress = Number(item.progress || 0);
    const key = getItemProcessKey(item);
    const linked = manualLinks[key];
    const reg = registry.items[key];
    const mangaId = linked && Number(linked.mangaId)
      ? Number(linked.mangaId)
      : (reg && Number(reg.matchedMangaId) ? Number(reg.matchedMangaId) : null);

    if (!mangaId || progress <= 0) {
      const row = { item, skipped: true, reason: mangaId ? 'no-progress' : 'no-linked-manga' };
      output.push(row);
      if (options.onItem) options.onItem(row);
      continue;
    }

    try {
      const chapters = await getMangaChapters(client, mangaId, false);
      const toDelete = (Array.isArray(chapters) ? chapters : [])
        .filter(ch => Boolean(ch && ch.downloaded))
        .filter(ch => isChapterStrictlyBeforeProgress(ch.chapterNumber, progress))
        .filter(ch => Number.isFinite(Number(ch.index)));

      let deleted = 0;
      let failed = 0;
      for (const ch of toDelete) {
        if (dry) continue;
        try {
          await deleteDownloadedChapter(client, Number(ch.index));
          deleted += 1;
        } catch (e) {
          failed += 1;
        }
      }

      const row = {
        item,
        mangaId,
        progress,
        candidates: toDelete.length,
        deleted,
        failed,
        dry
      };
      output.push(row);
      if (options.onItem) options.onItem(row);
    } catch (e) {
      const row = { item, mangaId, progress, ok: false, error: e.message };
      output.push(row);
      if (options.onItem) options.onItem(row);
    }
  }

  return {
    count: output.length,
    output
  };
}

async function stopDownloads() {
  const cfg = loadConfig();
  const apiUrl = cfg.apiUrl || 'http://localhost:4567';
  const client = makeApiClient(apiUrl, { timeout: Math.max(5000, Number(cfg.apiTimeoutMs || 30000)) });
  await stopDownloader(client);
  return true;
}

async function stopServer() {
  const cfg = loadConfig();
  const pid = Number(cfg._runnerPid || 0);
  if (!Number.isFinite(pid) || pid <= 0) {
    return { stopped: false, reason: 'no-runner-pid' };
  }

  let primaryStopped = false;
  let primaryReason = null;
  try {
    process.kill(pid);
    primaryStopped = true;
  } catch (e) {
    primaryReason = e.message;
  }

  // Best effort: also terminate manually started Suwayomi java processes on Windows.
  let aggressiveReason = null;
  if (process.platform === 'win32') {
    try {
      const ps = [
        "$targets = Get-CimInstance Win32_Process | Where-Object { ($_.Name -match '^java(w)?\\.exe$') -and ($_.CommandLine -match 'Suwayomi-Server') }",
        "foreach($p in $targets){ try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {} }",
        'Write-Output ($targets | Measure-Object).Count'
      ].join('; ');
      execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
    } catch (e) {
      aggressiveReason = e.message;
    }
  }

  cfg._runnerPid = null;
  saveConfig(cfg);

  return {
    stopped: primaryStopped,
    pid,
    reason: primaryReason,
    aggressiveReason
  };
}

async function stopKomga() {
  const cfg = loadConfig();
  const pid = Number(cfg._komgaRunnerPid || 0);
  if (!Number.isFinite(pid) || pid <= 0) {
    return { stopped: false, reason: 'no-komga-runner-pid' };
  }

  let primaryStopped = false;
  let primaryReason = null;
  try {
    process.kill(pid);
    primaryStopped = true;
  } catch (e) {
    primaryReason = e.message;
  }

  let aggressiveReason = null;
  if (process.platform === 'win32') {
    try {
      const ps = [
        "$targets = Get-CimInstance Win32_Process | Where-Object { ($_.Name -match '^java(w)?\\.exe$') -and ($_.CommandLine -match 'komga') }",
        "foreach($p in $targets){ try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {} }",
        'Write-Output ($targets | Measure-Object).Count'
      ].join('; ');
      execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
    } catch (e) {
      aggressiveReason = e.message;
    }
  }

  cfg._komgaRunnerPid = null;
  saveConfig(cfg);

  return {
    stopped: primaryStopped,
    pid,
    reason: primaryReason,
    aggressiveReason
  };
}

async function waitForDownloadsAndShutdown(options = {}) {
  const cfg = loadConfig();
  const apiUrl = cfg.apiUrl || 'http://localhost:4567';
  const timeoutMs = Number(options.timeoutMs || 0);
  const idleGraceMs = Number(options.idleGraceMs || 5000);

  const watcherResult = await waitForDownloadsToFinish(apiUrl, { timeoutMs, idleGraceMs });
  const stopped = await stopServer();
  return { watcherResult, stopped };
}

async function waitForDownloadsAndSyncKomga(options = {}) {
  const cfg = loadConfig();
  const apiUrl = cfg.apiUrl || 'http://localhost:4567';
  const timeoutMs = Number(options.timeoutMs || 0);
  const idleGraceMs = Number(options.idleGraceMs || 10000);

  const watcherResult = await waitForDownloadsToFinish(apiUrl, { timeoutMs, idleGraceMs });

  const organizeResult = await organizeDownloadsForKomga({
    mode: cfg.komgaOrganizeMode === 'copy' ? 'copy' : 'hardlink',
    createGhostFolders: cfg.komgaCreateGhostFolders === true,
    createSeriesMetadata: cfg.komgaCreateSeriesMetadata !== false,
    createSeriesCover: cfg.komgaCreateSeriesCover !== false,
    useDownloadsAsLibrary: cfg.komgaUseDownloadsAsLibrary !== false,
    forceSync: true
  });

  const scanResult = await triggerKomgaLibraryScan({
    scanDeep: true,
    scanForceModifiedTime: options.scanForceModifiedTime === true
  });

  const refreshResult = await triggerKomgaMetadataRefresh();
  const metadataPatchResult = await syncKomgaSeriesMetadataFromLocal();

  return {
    watcherResult,
    organizeResult,
    scanResult,
    refreshResult,
    metadataPatchResult
  };
}

function toPercent(item) {
  const p = Number(item && item.progress);
  if (Number.isFinite(p)) {
    if (p >= 0 && p <= 1) return Math.round(p * 100);
    if (p >= 0 && p <= 100) return Math.round(p);
  }

  const downloaded = Number(item && (item.downloadedPages || item.downloaded || item.done));
  const total = Number(item && (item.totalPages || item.total || item.size));
  if (Number.isFinite(downloaded) && Number.isFinite(total) && total > 0) {
    return Math.max(0, Math.min(100, Math.round((downloaded / total) * 100)));
  }

  return null;
}

function getQueueTitle(item) {
  if (!item || typeof item !== 'object') return 'Unknown title';
  return String(
    item.mangaTitle ||
    item.title ||
    (item.manga && item.manga.title) ||
    item.seriesTitle ||
    item.id ||
    'Unknown title'
  );
}

async function getDownloadsOverview() {
  const cfg = loadConfig();
  const apiUrl = cfg.apiUrl || 'http://localhost:4567';
  const client = makeApiClient(apiUrl, { timeout: Math.max(5000, Number(cfg.apiTimeoutMs || 30000)) });

  let state = null;
  try {
    state = await getDownloadsState(client);
  } catch (e) {
    // ignore and fallback to websocket snapshot
  }

  if (!state || typeof state !== 'object' || !Array.isArray(state.queue)) {
    try {
      state = await getDownloadsSnapshot(apiUrl, 4000);
    } catch (e) {
      state = { status: 'Unknown', queue: [] };
    }
  }

  const queue = Array.isArray(state.queue) ? state.queue : [];
  const registry = loadDownloadsRegistry();
  const regItems = registry && registry.items && typeof registry.items === 'object'
    ? Object.values(registry.items)
    : [];

  function getDiagForTitle(title) {
    const t = String(title || '').toLowerCase();
    const candidates = regItems.filter(x => {
      const a = String(x && x.matchedMangaTitle || '').toLowerCase();
      const b = String(x && x.title || '').toLowerCase();
      return (a && a === t) || (b && b === t);
    });
    if (!candidates.length) return null;
    candidates.sort((a, b) => {
      const ta = new Date(a.queuedAt || a.lastCheckedAt || a.failedAt || 0).getTime();
      const tb = new Date(b.queuedAt || b.lastCheckedAt || b.failedAt || 0).getTime();
      return tb - ta;
    });
    const latest = candidates[0];
    const meta = latest && latest.enqueueMeta ? latest.enqueueMeta : null;
    return {
      status: latest.status || '',
      attemptsTotal: Number(meta && meta.attemptsTotal || 0),
      sourceSwitches: Number(meta && meta.sourceSwitches || 0),
      warnings: Array.isArray(meta && meta.warnings) ? meta.warnings : [],
      sourceAttempts: Array.isArray(meta && meta.sourceAttempts) ? meta.sourceAttempts : [],
      sourceName: latest.matchedSourceName || ''
    };
  }
  const byTitle = new Map();
  for (const q of queue) {
    const title = getQueueTitle(q);
    if (!byTitle.has(title)) byTitle.set(title, []);
    byTitle.get(title).push(q);
  }

  const active = [...byTitle.entries()].map(([title, items]) => {
    const percents = items.map(toPercent).filter(p => Number.isFinite(p));
    const avgPercent = percents.length
      ? Math.round(percents.reduce((acc, n) => acc + n, 0) / percents.length)
      : null;
    return {
      title,
      chaptersInQueue: items.length,
      percent: avgPercent,
      diag: getDiagForTitle(title)
    };
  });

  const failedRecent = regItems
    .filter(x => String(x && x.status || '') === 'failed')
    .sort((a, b) => new Date(b.failedAt || 0).getTime() - new Date(a.failedAt || 0).getTime())
    .slice(0, 20)
    .map(x => ({
      title: x.title || x.searchKey || 'unknown',
      error: x.error || 'unknown-error',
      failedAt: x.failedAt || '',
      enqueueMeta: x.enqueueMeta || null
    }));

  let files = [];
  try {
    const downloadRoot = cfg.downloadsPath || (cfg.dataDir ? path.join(cfg.dataDir, 'downloads') : null);
    if (downloadRoot && fs.existsSync(downloadRoot)) {
      files = fs.readdirSync(downloadRoot)
        .filter(name => name.toLowerCase().endsWith('.cbz') || fs.statSync(path.join(downloadRoot, name)).isDirectory())
        .slice(0, 200);
    }
  } catch (e) {
    // ignore listing errors
  }

  return {
    status: state.status || 'Unknown',
    queueSize: queue.length,
    active,
    failedRecent,
    files,
    config: {
      usernameAnilist: cfg.usernameAnilist || '',
      capsAhead: Number(cfg.capsAhead) || 5,
      downloadsPath: cfg.downloadsPath || ''
    }
  };
}

async function organizeDownloadsForKomga(options = {}) {
  const cfg = loadConfig();
  const downloadsRoot = cfg.downloadsPath || (cfg.dataDir ? path.join(cfg.dataDir, 'downloads') : null);
  const useDownloadsAsLibrary = options.useDownloadsAsLibrary == null
    ? Boolean(cfg.komgaUseDownloadsAsLibrary !== false)
    : Boolean(options.useDownloadsAsLibrary);
  const libraryRoot = useDownloadsAsLibrary
    ? downloadsRoot
    : (cfg.komgaLibraryPath || (cfg.dataDir ? path.join(cfg.dataDir, 'komga-library') : null));
  const force = Boolean(options.forceSync);
  const cfgMode = cfg.komgaOrganizeMode === 'copy' ? 'copy' : 'hardlink';
  const mode = options.mode === 'copy' || options.mode === 'hardlink' ? options.mode : cfgMode;
  const createGhostFolders = options.createGhostFolders == null
    ? Boolean(cfg.komgaCreateGhostFolders)
    : Boolean(options.createGhostFolders);
  const createSeriesMetadata = options.createSeriesMetadata == null
    ? Boolean(cfg.komgaCreateSeriesMetadata !== false)
    : Boolean(options.createSeriesMetadata);
  const createSeriesCover = options.createSeriesCover == null
    ? Boolean(cfg.komgaCreateSeriesCover !== false)
    : Boolean(options.createSeriesCover);

  if (!downloadsRoot || !fs.existsSync(downloadsRoot)) {
    throw new Error('Downloads path does not exist.');
  }
  if (!libraryRoot) {
    throw new Error('Komga library path is not configured.');
  }

  if (!force && shouldSkipKomgaSyncToday(cfg.lastKomgaLibrarySyncAt)) {
    return {
      downloadsRoot,
      libraryRoot,
      mode,
      skippedByRecentSync: true,
      lastSyncAt: cfg.lastKomgaLibrarySyncAt || null,
      foundCbz: 0,
      copied: 0,
      linked: 0,
      skipped: 0,
      seriesCount: 0,
      ghostFolders: 0,
      metadataCreated: 0,
      coverCreated: 0,
      createSeriesMetadata,
      createSeriesCover
    };
  }

  ensureDir(libraryRoot);

  const allFiles = walkFilesRecursively(downloadsRoot);
  const cbzFiles = allFiles.filter(f => f.toLowerCase().endsWith('.cbz'));

  let copied = 0;
  let linked = 0;
  let moved = 0;
  let skipped = 0;
  const touchedSeries = new Set();
  const seriesSources = new Map();

  for (const src of cbzFiles) {
    // Never move chapters here. We only enrich existing series folders.
    const seriesDir = path.dirname(src);
    const series = sanitizeFsName(path.basename(seriesDir));
    touchedSeries.add(series);
    if (!seriesSources.has(series)) seriesSources.set(series, path.dirname(src));
  }

  const ghostFolders = 0;

  let metadataCreated = 0;
  let comicInfoCreated = 0;
  let coverCreated = 0;
  const metadataIndex = createSeriesMetadata ? buildListMetadataIndex() : null;
  for (const series of touchedSeries) {
    const seriesDir = seriesSources.get(series);
    if (!seriesDir || !fs.existsSync(seriesDir)) continue;
    const matched = metadataIndex ? findSeriesMetadata(series, metadataIndex) : null;

    if (createSeriesMetadata) {
      try {
        writeSeriesMetadataFile(seriesDir, series, matched);
        metadataCreated += 1;
      } catch (e) {
        // ignore metadata write failure per series
      }

      try {
        writeSeriesComicInfoFile(seriesDir, series, matched);
        comicInfoCreated += 1;
      } catch (e) {
        // ignore ComicInfo write failure per series
      }
    }

    if (createSeriesCover) {
      try {
        const status = await ensureSeriesCoverFile(seriesDir, seriesSources.get(series), matched);
        if (status === 'created' || status === 'created-from-anilist') coverCreated += 1;
      } catch (e) {
        // ignore cover copy failure per series
      }
    }
  }

  cfg.lastKomgaLibrarySyncAt = new Date().toISOString();
  saveConfig(cfg);

  return {
    downloadsRoot,
    libraryRoot,
    mode,
    foundCbz: cbzFiles.length,
    copied,
    linked,
    moved,
    skipped,
    seriesCount: touchedSeries.size,
    ghostFolders,
    metadataCreated,
    comicInfoCreated,
    coverCreated,
    createSeriesMetadata,
    createSeriesCover,
    useDownloadsAsLibrary,
    skippedByRecentSync: false,
    lastSyncAt: cfg.lastKomgaLibrarySyncAt || null
  };
}

async function getChapterCoverageReport(options = {}) {
  const cfg = loadConfig();
  const apiUrl = cfg.apiUrl || 'http://localhost:4567';
  const client = makeApiClient(apiUrl);
  const capsAhead = Number(cfg.capsAhead || 5);
  const limit = Math.max(1, Number(options.limit || 80));

  const prepared = readListForEnqueue();
  const list = prepared.list.slice(0, limit);
  const links = getManualLinks(cfg);
  const rows = [];

  for (const item of list) {
    const key = getItemProcessKey(item);
    const linked = links[key] || null;
    const wanted = buildWantedChapterNumbers(item.progress || 0, capsAhead);

    if (!linked) {
      rows.push({
        title: item.title,
        progress: Number(item.progress || 0),
        wantedRange: `${wanted[0]}-${wanted[wanted.length - 1]}`,
        linked: false,
        status: 'no-manual-link'
      });
      continue;
    }

    try {
      const mangaId = Number(linked.mangaId);
      const chapters = await getMangaChapters(client, mangaId, true);
      const downloadedNumbers = chapters
        .filter(ch => ch && ch.downloaded)
        .map(ch => Number(ch.chapterNumber))
        .filter(Number.isFinite);

      const maxDownloaded = downloadedNumbers.length ? Math.max(...downloadedNumbers) : 0;
      const wantedMissing = wanted.filter(w => !downloadedNumbers.some(n => Math.abs(n - w) <= 0.51));

      rows.push({
        title: item.title,
        progress: Number(item.progress || 0),
        wantedRange: `${wanted[0]}-${wanted[wanted.length - 1]}`,
        linked: true,
        sourceName: linked.sourceName || linked.sourceId,
        mangaTitle: linked.mangaTitle,
        maxDownloaded,
        missingCount: wantedMissing.length,
        missingWanted: wantedMissing.slice(0, 10),
        status: wantedMissing.length ? 'needs-download' : 'covered'
      });
    } catch (e) {
      rows.push({
        title: item.title,
        progress: Number(item.progress || 0),
        wantedRange: `${wanted[0]}-${wanted[wanted.length - 1]}`,
        linked: true,
        sourceName: linked.sourceName || linked.sourceId,
        mangaTitle: linked.mangaTitle,
        status: 'error',
        error: e.message
      });
    }
  }

  return {
    capsAhead,
    total: rows.length,
    rows
  };
}

module.exports = {
  CONFIG_PATH,
  LIST_PATH,
  DOWNLOADS_PATH,
  LINK_CACHE_PATH,
  loadConfig,
  saveConfig,
  isConfigComplete,
  moveJarToManagedFolder,
  applyConfigValues,
  syncServerConf,
  startServer,
  startKomga,
  fetchUserList,
  listRepos,
  addRepo,
  removeRepos,
  fetchRepoIndexes,
  getServerExtensions,
  installPackages,
  getSources,
  getItemProcessKey,
  listMangaItemsForManualLink,
  searchManualLinkCandidates,
  getManualLinkRuntimeStatus,
  getAutoLinkCandidates,
  getCachedAutoLinkCandidates,
  buildBatchAutoLinkPreview,
  warmAutoLinkCache,
  checkSourcesHealth,
  setManualLink,
  removeManualLink,
  enqueueFromList,
  deleteReadChaptersByAniList,
  getDownloadsOverview,
  triggerKomgaMetadataRefresh,
  syncKomgaSeriesMetadataFromLocal,
  organizeDownloadsForKomga,
  ensureKomgaLibraryExists,
  triggerKomgaLibraryScan,
  getChapterCoverageReport,
  stopDownloads,
  stopServer,
  stopKomga,
  waitForDownloadsAndShutdown,
  waitForDownloadsAndSyncKomga
};
