const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const { execFileSync } = require('child_process');

const { fetchAniList, fetchAniListMediaById } = require('./shared/adapters/anilist.adapter');
const { fetchMAL } = require('./shared/adapters/mal.adapter');
const { normalize } = require('./shared/utils/normalize');
const { postGraphQL, sleep } = require('./shared/utils/api-common');
const { loadSuwayomiLibraryIndex } = require('./features/links/infra/load-suwayomi-library-index');
const { resolveItemLibraryLink } = require('./features/links/application/resolve-item-library-link');
const { linkItemInLibrary } = require('./features/links/application/link-item-in-library');
const { unlinkItemFromLibrary } = require('./features/links/application/unlink-item-from-library');
// Suwayomi server & API (feature modules)
const { startSuwayomiJar, waitForSuwayomiReady: waitForReady } = require('./features/server/infra/suwayomi-runner');
const { startKomga: _komgaStartNew, startKomgaJar, waitForKomgaReady, getEffectiveKomgaJavaArgs, moveJarToManaged: _moveJarKomga } = require('./features/komga/infra/komga-runner');
const {
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
  getDownloadsSnapshot,
  waitForDownloadsToFinish
} = require('./features/server/infra/suwayomi-api');

// Komga organizer
const { organizeDownloadsForKomga } = require('./features/komga/infra/komga-organizer');

// Config & path functions (re-exported for backward compatibility)
const {
  DEV_DATA_ROOT,
  PACKAGED_STATE_ROOT,
  PACKAGED_BOOTSTRAP_PATH,
  DEFAULT_MANAGED_DIR,
  DATA_DIR_ENV_KEY,
  readPackagedBootstrap,
  writePackagedBootstrap,
  hasConfigAt,
  toDataRootFromDir,
  readDataDirFromConfigFile,
  resolveDataRoot,
  getDataPaths,
  getConfigPath,
  getListPath,
  getDownloadsPath,
  getLinkCachePath,
  loadConfig,
  saveConfig,
  quotePathForHocon
} = require('./features/config/infra/config-store');

const CONFIG_PATH = getConfigPath();
const LIST_PATH = getListPath();
const DOWNLOADS_PATH = getDownloadsPath();
const LINK_CACHE_PATH = getLinkCachePath();

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
  if (overwrite) fs.mkdirSync(managedDir, { recursive: true });
  if (path.resolve(sourceJarPath) === path.resolve(path.join(managedDir, path.basename(sourceJarPath)))) return path.join(managedDir, path.basename(sourceJarPath));
  return _moveJarKomga(sourceJarPath, managedDir);
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
  cfg.cleanupLibraryDuplicates = cfg.cleanupLibraryDuplicates === true;
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
  const { buildWantedChapterNumbers: fn } = require('./features/enqueue/domain/enqueue-utils');
  return fn(progress, capsAhead);
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

  const runner = startSuwayomiJar(Object.assign({}, cfg, {
    javaArgs: cfg.javaArgs || [],
    detached: true
  }));

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

// Backward-compatible wrapper: legacy startKomga wrapper that uses the new startKomgaJar from komga-runner
// Old callers in menus/pipelines may still reference this signature via cli-logic
async function _startKomgaLegacy() {
  const cfg = loadConfig();
  if (!cfg.komgaJarPath) throw new Error('No Komga JAR configured.');
  if (!cfg.dataDir) throw new Error('No data folder configured.');

  const managedJarDir = path.join(cfg.dataDir, 'bin');
  try {
    cfg.komgaJarPath = _moveJarKomga(cfg.komgaJarPath, managedJarDir);
  } catch (e) {
    throw new Error(`Failed to move Komga JAR to managed bin folder: ${e.message}`);
  }

  cfg.komgaDataDir = cfg.komgaDataDir || path.join(cfg.dataDir, 'komga');
  cfg.komgaUrl = cfg.komgaUrl || 'http://localhost:25600';
  fs.mkdirSync(cfg.komgaDataDir, { recursive: true });
  saveConfig(cfg);

  const runner = startKomgaJar(cfg.komgaJarPath, {
    javaArgs: getEffectiveKomgaJavaArgs(cfg),
    appArgs: cfg.komgaAppArgs || [],
    detached: true,
    cwd: cfg.komgaDataDir,
    env: { ...process.env, KOMGA_CONFIGDIR: cfg.komgaDataDir }
  });

  const ready = await waitForKomgaReady(cfg.komgaUrl, 30000, 1000);
  cfg._komgaRunnerPid = runner.proc.pid;
  saveConfig(cfg);
  return { cfg, ready, pid: runner.proc.pid, komgaUrl: cfg.komgaUrl };
}

// Re-export alias for backward compatibility
const startKomga = _startKomgaLegacy;

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
  const { getItemProcessKey: fn } = require('./features/enqueue/domain/enqueue-utils');
  return fn(item);
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
  const { chaptersAreAlreadyCovered: fn } = require('./features/enqueue/domain/enqueue-utils');
  return fn(existingRequestedChapters, currentRequestedChapters);
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

function buildUniqueSearchTermsForLinkResolution(item, linked, fallbackTerms = []) {
  const out = [];
  const push = (v) => {
    const s = String(v || '').trim();
    if (!s) return;
    if (!out.some(x => x.toLowerCase() === s.toLowerCase())) out.push(s);
  };

  push(linked && linked.mangaTitle);
  push(item && item.title);
  (Array.isArray(item && item.altTitles) ? item.altTitles : []).forEach(push);
  (Array.isArray(fallbackTerms) ? fallbackTerms : []).forEach(push);
  push(item && item.searchKey);

  return out.slice(0, 10);
}

async function resolveManualLinkAgainstSource(client, item, linked, options = {}) {
  if (!linked || linked.sourceId == null) {
    return { ok: false, reason: 'manual-link-missing' };
  }

  const strictMinScore = Number(options.strictMinScore || 88);
  const allowOnlineResolve = options.allowOnlineResolve === true;
  const sourceId = String(linked.sourceId);
  const terms = buildUniqueSearchTermsForLinkResolution(item, linked, options.searchTerms || []);
  if (!terms.length) {
    return { ok: false, reason: 'no-terms-for-resolution' };
  }

  const sourceList = Array.isArray(options.sources) && options.sources.length
    ? options.sources
    : await listSources(client);
  const source = Array.isArray(sourceList)
    ? sourceList.find(s => String(s && s.id) === sourceId)
    : null;

  if (!source) {
    return { ok: false, reason: 'source-not-found' };
  }

  const libraryEntries = Array.isArray(options.libraryEntries) ? options.libraryEntries : [];
  if (libraryEntries.length) {
    const sourceLibrary = libraryEntries
      .filter(m => String(m && m.sourceId || '') === sourceId)
      .filter(m => m && m.inLibrary !== false)
      .map(m => ({
        mangaId: Number(m && m.id),
        mangaTitle: String(m && m.title || '').trim()
      }))
      .filter(m => Number.isFinite(m.mangaId) && m.mangaTitle);

    let bestLibrary = null;
    for (const m of sourceLibrary) {
      const scored = scoreCandidateAgainstItemTitles(item, m.mangaTitle);
      if (!bestLibrary || Number(scored.score || 0) > Number(bestLibrary.score || 0)) {
        bestLibrary = {
          sourceId,
          sourceName: source.name || sourceId,
          mangaId: m.mangaId,
          mangaTitle: m.mangaTitle,
          score: Number(scored.score || 0),
          matchedAgainst: scored.matchedAgainst || ''
        };
      }
    }

    if (bestLibrary && Number(bestLibrary.score || 0) >= strictMinScore) {
      return { ok: true, link: bestLibrary };
    }
  }

  // Fast path: use what is already in Suwayomi library for this saved mangaId.
  const linkedMangaId = Number(linked.mangaId);
  if (Number.isFinite(linkedMangaId)) {
    try {
      const info = await client.get(`/api/v1/manga/${linkedMangaId}`);
      const title = String(info && info.title || linked.mangaTitle || '').trim();
      const scored = scoreCandidateAgainstItemTitles(item, title);
      if (Number(scored.score || 0) >= strictMinScore) {
        return {
          ok: true,
          link: {
            sourceId,
            sourceName: source.name || sourceId,
            mangaId: linkedMangaId,
            mangaTitle: title,
            score: Number(scored.score || 0),
            matchedAgainst: scored.matchedAgainst || ''
          }
        };
      }

      return { ok: false, reason: `library-title-mismatch(${scored.score}<${strictMinScore})` };
    } catch (e) {
      // If manga is no longer valid in local library, fallback behavior below applies.
    }
  }

  if (!allowOnlineResolve) {
    return { ok: false, reason: 'library-only-mode-no-valid-local-id' };
  }

  let best = null;
  for (const term of terms) {
    let page = null;
    try {
      page = await searchSource(client, sourceId, term, 1);
    } catch (e) {
      continue;
    }

    const mangas = Array.isArray(page && page.mangaList) ? page.mangaList : [];
    for (const manga of mangas) {
      const mangaId = Number(manga && manga.id);
      if (!Number.isFinite(mangaId)) continue;

      const title = String((manga && manga.title) || '').trim();
      if (!title) continue;

      const scored = scoreCandidateAgainstItemTitles(item, title);
      if (!best || Number(scored.score || 0) > Number(best.score || 0)) {
        best = {
          sourceId,
          sourceName: source.name || sourceId,
          mangaId,
          mangaTitle: title,
          score: Number(scored.score || 0),
          matchedAgainst: scored.matchedAgainst || ''
        };
      }
    }

    if (best && Number(best.score || 0) >= 98) break;
  }

  if (!best) {
    return { ok: false, reason: 'no-candidate-found' };
  }

  if (Number(best.score || 0) < strictMinScore) {
    return { ok: false, reason: `low-confidence(${best.score}<${strictMinScore})`, candidate: best };
  }

  return { ok: true, link: best };
}

async function getSuwayomiLibraryEntries(client, context = null) {
  if (context && Array.isArray(context._suwayomiLibraryEntries)) {
    return context._suwayomiLibraryEntries;
  }

  try {
    const rows = await client.get('/api/v1/category/0');
    const arr = Array.isArray(rows) ? rows : [];
    if (context) context._suwayomiLibraryEntries = arr;
    return arr;
  } catch (e) {
    if (context) context._suwayomiLibraryEntries = [];
    return [];
  }
}

function findBestLibraryLinkForItem(item, libraryEntries = [], sourceNameById = null, strictMinScore = 88) {
  return resolveItemLibraryLink({
    item,
    libraryEntries,
    sourceNameById: sourceNameById instanceof Map ? sourceNameById : new Map(),
    strictMinScore,
    scoreCandidate: scoreCandidateAgainstItemTitles
  });
}

function isFallbackMatchSafe(item, fixed, cfg) {
  const strictMinScore = Number(cfg && cfg.strictMinScore || 88);
  const candidateTitle = String(fixed && fixed.mangaTitle || '').trim();
  if (!candidateTitle) return { ok: false, reason: 'sem-titulo-candidato', overallScore: 0, primaryScore: 0 };

  const primaryInput = String((item && item.title) || (item && item.searchKey) || '').trim();
  const primaryScore = primaryInput ? scoreTwoTitlesForAutoLink(primaryInput, candidateTitle) : 0;
  const overall = scoreCandidateAgainstItemTitles(item || {}, candidateTitle);
  const overallScore = Number(overall && overall.score || fixed && fixed.score || 0);

  const looksDoujinshi = /doujinshi|\bdj\b|fanbook|artbook|anthology/i.test(candidateTitle);
  if (looksDoujinshi && !/doujinshi|\bdj\b/i.test(primaryInput)) {
    return { ok: false, reason: 'doujinshi-suspeito', overallScore, primaryScore };
  }

  if (overallScore < strictMinScore) {
    return { ok: false, reason: `score-geral-baixo(${overallScore}<${strictMinScore})`, overallScore, primaryScore };
  }

  // Strong guard against generic alias mismatches: primary title must still match well.
  if (primaryScore < Math.max(84, strictMinScore - 4)) {
    return { ok: false, reason: `score-titulo-principal-baixo(${primaryScore})`, overallScore, primaryScore };
  }

  return { ok: true, reason: '', overallScore, primaryScore, matchedAgainst: overall && overall.matchedAgainst ? overall.matchedAgainst : '' };
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

async function setManualLink(item, link) {
  const cfg = loadConfig();
  const apiUrl = cfg.apiUrl || 'http://localhost:4567';
  const timeoutMs = Math.max(5000, Number(cfg.apiTimeoutMs || 30000));
  const client = makeApiClient(apiUrl, { timeout: timeoutMs });
  return linkItemInLibrary({
    client,
    addMangaToLibrary,
    link,
    fallbackTitle: item && item.title ? item.title : ''
  });
}

async function removeManualLink(item) {
  const cfg = loadConfig();
  const apiUrl = cfg.apiUrl || 'http://localhost:4567';
  const timeoutMs = Math.max(5000, Number(cfg.apiTimeoutMs || 30000));
  const client = makeApiClient(apiUrl, { timeout: timeoutMs });
  const index = await loadSuwayomiLibraryIndex({ client, listSources });
  return unlinkItemFromLibrary({
    client,
    removeMangaFromLibrary,
    item,
    libraryEntries: index.entries,
    sourceNameById: index.sourceNameById,
    strictMinScore: Number(cfg.strictMinScore || 88),
    scoreCandidate: scoreCandidateAgainstItemTitles
  });
}

async function listMangaItemsForManualLink(limit = 300) {
  const prepared = readListForEnqueue();
  const cfg = loadConfig();
  const apiUrl = cfg.apiUrl || 'http://localhost:4567';
  const timeoutMs = Math.max(5000, Number(cfg.apiTimeoutMs || 30000));
  const client = makeApiClient(apiUrl, { timeout: timeoutMs });
  const index = await loadSuwayomiLibraryIndex({ client, listSources });
  const strictMinScore = Number(cfg.strictMinScore || 88);

  return prepared.list.slice(0, limit).map(item => {
    const key = getItemProcessKey(item);
    const linked = resolveItemLibraryLink({
      item,
      libraryEntries: index.entries,
      sourceNameById: index.sourceNameById,
      strictMinScore,
      scoreCandidate: scoreCandidateAgainstItemTitles
    });
    return {
      key,
      item,
      linked: linked || null
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
  const apiUrl = cfg.apiUrl || 'http://localhost:4567';
  const client = makeApiClient(apiUrl, { timeout: Math.max(5000, Number(cfg.apiTimeoutMs || 30000)) });
  const strictMinScore = Number(cfg.strictMinScore || 88);
  const index = await loadSuwayomiLibraryIndex({ client, listSources });
  const linked = resolveItemLibraryLink({
    item,
    libraryEntries: index.entries,
    sourceNameById: index.sourceNameById,
    strictMinScore,
    scoreCandidate: scoreCandidateAgainstItemTitles
  });

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

  // Keep preview resilient: if language filters remove all sources, fallback to all installed sources.
  if (!sources.length) {
    sources = rawSources;
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
  const allowFallbackOnLinkedFailure = context.cfg.allowFallbackOnLinkedFailure === true;
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
    const libraryEntries = await getSuwayomiLibraryEntries(client, context);
    const resolved = await resolveManualLinkAgainstSource(client, item, linked, {
      sources: base.sources,
      searchTerms: base.searchTerms,
      strictMinScore: base.strictMinScore,
      allowOnlineResolve: context.cfg.allowOnlineResolveForManualLink === true,
      libraryEntries
    });

    if (!resolved.ok) {
      const err = new Error(`Nao foi possivel resolver vinculo manual para "${item.title || item.searchKey}": ${resolved.reason}`);
      err.code = 'MANUAL_LINK_RESOLVE_FAILED';
      err.report = report;
      return { ok: false, error: err, report };
    }

    const effectiveLinked = {
      ...linked,
      sourceId: String(resolved.link.sourceId),
      sourceName: resolved.link.sourceName || linked.sourceName || String(resolved.link.sourceId),
      mangaId: Number(resolved.link.mangaId),
      mangaTitle: resolved.link.mangaTitle || linked.mangaTitle || item.title || ''
    };

    if (
      String(effectiveLinked.sourceId) !== String(linked.sourceId)
      || Number(effectiveLinked.mangaId) !== Number(linked.mangaId)
      || String(effectiveLinked.mangaTitle || '') !== String(linked.mangaTitle || '')
    ) {
      effectiveLinked.updatedAt = new Date().toISOString();
    }

    const primary = await tryFixedMatchWithRetries(client, item, chapters, priority || [], base, effectiveLinked, retriesPerSource);
    report.attemptsTotal += primary.attempts.length;
    report.sourceAttempts.push({
      sourceId: String(effectiveLinked.sourceId),
      sourceName: effectiveLinked.sourceName || String(effectiveLinked.sourceId),
      mangaId: Number(effectiveLinked.mangaId),
      mangaTitle: effectiveLinked.mangaTitle || item.title || '',
      failedAttempts: primary.attempts.filter(a => !a.ok).length,
      attempts: primary.attempts,
      lastError: primary.error ? String(primary.error.message || primary.error) : ''
    });

    if (primary.ok) {
      return { ok: true, result: primary.result, report };
    }

    report.warnings.push(`Fonte ${effectiveLinked.sourceName || effectiveLinked.sourceId} falhou ${retriesPerSource}x; pode estar com defeito.`);

    if (!allowFallbackOnLinkedFailure) {
      const err = new Error(`Vinculo manual falhou para "${item.title || item.searchKey}" e fallback automatico esta desativado.`);
      err.code = 'MANUAL_LINK_FAILED_NO_FALLBACK';
      err.report = report;
      return { ok: false, error: err, report };
    }

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
      const safe = isFallbackMatchSafe(item, fixed, context.cfg);
      if (!safe.ok) {
        report.warnings.push(`Ignorando fallback ${fixed.sourceName || fixed.sourceId} / ${fixed.mangaTitle || ''}: ${safe.reason}`);
        continue;
      }

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
    const safe = isFallbackMatchSafe(item, fixed, cfg);
    if (!safe.ok) {
      attempts.push({ fixed, error: `unsafe-fallback:${safe.reason}` });
      continue;
    }

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
  const libraryIndex = await loadSuwayomiLibraryIndex({ client, listSources });
  const libraryEntries = libraryIndex.entries;
  const sourceNameById = libraryIndex.sourceNameById;
  let skippedAlreadyProcessed = 0;
  const notFound = [];

  for (const item of toProcess) {
    const chapters = buildWantedChapterNumbers(item.progress || 0, capsAhead);

    const itemKey = getItemProcessKey(item);
    const linked = resolveItemLibraryLink({
      item,
      libraryEntries,
      sourceNameById,
      strictMinScore: Number(cfg.strictMinScore || 88),
      scoreCandidate: scoreCandidateAgainstItemTitles
    });

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

      if (result && result.fallbackUsed && result.source && result.manga) {
        result.linkUpdated = false;
        result.linkPersistSkippedReason = 'library-is-source-of-truth';
      }

      if (result && result.alreadyQueuedOrDownloaded) {
        if (cfg.cleanupLibraryDuplicates === true) {
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

      if (cfg.cleanupLibraryDuplicates === true) {
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

  const rows = await listMangaItemsForManualLink(Math.max(300, limit * 2));
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

  const rows = await listMangaItemsForManualLink(Math.max(300, limit));
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

async function warmAndBuildPreview(options = {}) {
  const warm = await warmAutoLinkCache(options);
  const previewRows = await buildBatchAutoLinkPreview(options);
  return { warm, previewRows };
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
  const libraryIndex = await loadSuwayomiLibraryIndex({ client, listSources });
  const sourceNameById = libraryIndex.sourceNameById;
  const libraryEntries = libraryIndex.entries;
  const registry = loadDownloadsRegistry();
  const output = [];

  for (const item of rows) {
    const progress = Number(item.progress || 0);
    const key = getItemProcessKey(item);
    const linked = resolveItemLibraryLink({
      item,
      libraryEntries,
      sourceNameById,
      strictMinScore: Number(cfg.strictMinScore || 88),
      scoreCandidate: scoreCandidateAgainstItemTitles
    });
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
    if (process.platform === 'win32') {
      execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'pipe'
      });
    } else {
      process.kill(pid);
    }
    primaryStopped = true;
  } catch (e) {
    primaryReason = e.message;
  }

  let aggressiveReason = null;
  let aggressiveKilled = 0;
  if (process.platform === 'win32') {
    try {
      const ps = [
        "$targets = Get-CimInstance Win32_Process | Where-Object { ($_.Name -match '^java(w)?\\.exe$') -and ($_.CommandLine -match 'komga') }",
        "foreach($p in $targets){ try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {} }",
        'Write-Output ($targets | Measure-Object).Count'
      ].join('; ');
      const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
      const n = Number(String(out || '').trim());
      aggressiveKilled = Number.isFinite(n) ? n : 0;
    } catch (e) {
      aggressiveReason = e.message;
    }
  }

  const alreadyGone = typeof primaryReason === 'string' && /ESRCH/i.test(primaryReason);
  const stopped = primaryStopped || aggressiveKilled > 0 || alreadyGone;
  if (stopped) {
    cfg._komgaRunnerPid = null;
  }
  saveConfig(cfg);

  return {
    stopped,
    pid,
    reason: primaryReason,
    aggressiveReason,
    aggressiveKilled
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

  const refreshResult = await triggerKomgaMetadataRefresh();
  const metadataPatchResult = await syncKomgaSeriesMetadataFromLocal();

  const scanResult = await triggerKomgaLibraryScan({
    scanDeep: true,
    scanForceModifiedTime: options.scanForceModifiedTime === true
  });

  return {
    watcherResult,
    organizeResult,
    scanResult,
    refreshResult,
    metadataPatchResult
  };
}

function toPercent(item) {
  const { toPercent: fn } = require('./features/enqueue/domain/enqueue-utils');
  return fn(item);
}

function getQueueTitle(item) {
  const { getQueueTitle: fn } = require('./features/enqueue/domain/enqueue-utils');
  return fn(item);
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

// organizeDownloadsForKomga is imported from komga-organizer.js (line 38)

async function getChapterCoverageReport(options = {}) {
  const cfg = loadConfig();
  const apiUrl = cfg.apiUrl || 'http://localhost:4567';
  const client = makeApiClient(apiUrl);
  const capsAhead = Number(cfg.capsAhead || 5);
  const limit = Math.max(1, Number(options.limit || 80));

  const prepared = readListForEnqueue();
  const list = prepared.list.slice(0, limit);
  const libraryIndex = await loadSuwayomiLibraryIndex({ client, listSources });
  const sourceNameById = libraryIndex.sourceNameById;
  const libraryEntries = libraryIndex.entries;
  const rows = [];

  for (const item of list) {
    const linked = resolveItemLibraryLink({
      item,
      libraryEntries,
      sourceNameById,
      strictMinScore: Number(cfg.strictMinScore || 88),
      scoreCandidate: scoreCandidateAgainstItemTitles
    });
    const wanted = buildWantedChapterNumbers(item.progress || 0, capsAhead);

    if (!linked) {
      rows.push({
        title: item.title,
        progress: Number(item.progress || 0),
        wantedRange: `${wanted[0]}-${wanted[wanted.length - 1]}`,
        linked: false,
        status: 'not-in-suwayomi-library'
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

// ============================================================================
// DOWNLOAD MANUAL - Integração AniList + Suwayomi
// ============================================================================

/**
 * Busca a lista de mangás do AniList com informações de progresso
 */
async function fetchAniListMangaWithProgress(username) {
  const { getAniListClient } = require('../features/list/infra/anilist-client');
  const client = getAniListClient();

  // Busca lista de mangás do usuário
  const query = `
    query ($user: String) {
      MediaListCollection(userName: $user, type: MANGA, sort: UPDATED_TIME_DESC) {
        lists {
          entries {
            media {
              id
              title {
                romaji
                english
                native
              }
              chapters
            }
            progress
            status
          }
        }
      }
    }
  `;

  const result = await client.request(query, { user: username });
  const allEntries = (result.data.MediaListCollection.lists || []).flatMap(l => l.entries || []);

  // Formata para uso interno
  return allEntries.map(entry => ({
    anilistId: entry.media.id,
    title: entry.media.title.romaji || entry.media.title.english || entry.media.title.native || 'Sem título',
    totalChapters: entry.media.chapters || 0,
    lastChapterRead: entry.progress || 0,
    status: entry.status
  })).filter(m => m.totalChapters > 0);
}

/**
 * Busca o próximo capítulo não lido de um manga no Suwayomi
 * Retorna o número do último capítulo baixado
 */
async function getDownloadedChapterCount(mangaId) {
  try {
    const { default: axios } = await import('axios');
    const cfg = loadConfig();

    // Buscar no banco do Suwayomi
    const response = await axios.get(
      `${cfg.serverUrl || 'http://localhost:8080'}/api/v1/manga/${mangaId}/chapter`,
      { responseType: 'json' }
    );

    if (response.data && Array.isArray(response.data)) {
      // Encontrar o capítulo com maior número
      const chapters = response.data;
      if (chapters.length === 0) return 0;
      const maxChapterNum = chapters.reduce((max, ch) => {
        const num = parseFloat(ch.chapter || 0);
        return num > max ? num : max;
      }, 0);
      return Math.floor(maxChapterNum);
    }
    return 0;
  } catch (e) {
    console.log(`[DEBUG] Erro ao buscar capítulos do manga ${mangaId}: ${e.message}`);
    return 0;
  }
}

/**
 * Enfileira download de um manga com range específico de capítulos
 */
async function enqueueMangaDownload(mangaId, startChapter, endChapter, priority = 5) {
  const { default: axios } = await import('axios');
  const cfg = loadConfig();

  const url = `${cfg.serverUrl || 'http://localhost:8080'}/api/v1/download/add`;
  const payload = {
    mangaId,
    startChapter,
    endChapter,
    priority
  };

  const response = await axios.post(url, payload);
  return response.data;
}

/**
 * Busca um manga no Suwayomi pelo título
 * Retorna o manga encontrado ou null
 */
async function findMangaInSuwayomiByTitle(title) {
  const { default: axios } = await import('axios');
  const cfg = loadConfig();
  const apiUrl = cfg.apiUrl || 'http://localhost:4567';
  const client = makeApiClient(apiUrl);

  try {
    // Buscar todas as fontes
    const sources = await listSources(client);
    if (!sources || !sources.length) {
      throw new Error('Nenhuma fonte disponível no Suwayomi');
    }

    // Buscar em cada fonte
    for (const source of sources) {
      try {
        const results = await searchSource(source.id, title, 5);
        if (results && results.length > 0) {
          // Retorna o primeiro match
          return {
            mangaId: results[0].id,
            sourceId: source.id,
            sourceName: source.name,
            title: results[0].title
          };
        }
      } catch (e) {
        // Continua para próxima fonte
        continue;
      }
    }
    return null;
  } catch (e) {
    console.log(`[DEBUG] Erro ao buscar manga: ${e.message}`);
    return null;
  }
}

/**
 * UI para download manual de manga
 */
async function downloadManualMangaUI(deps) {
  const { ensurePrompt, presenter } = deps;
  const prompt = ensurePrompt();
  const ui = require('../feedback/ui-enhancements');

  const cfg = presenter.loadConfig();
  if (!cfg.usernameAnilist) {
    ui.NotificationManager.instance.error('Configure um usuário AniList primeiro!');
    await prompt([{ name: 'ok', message: 'Pressione Enter para continuar...' }]);
    return;
  }

  await ui.withSpinner('Buscando lista do AniList', async () => {
    // Garantir que Suwayomi está rodando
    if (!presenter.isServerRunning()) {
      ui.NotificationManager.instance.info('Iniciando Suwayomi...');
      await presenter.startServer();
    }
  });

  // Buscar lista do AniList
  const anilistMangas = await ui.withSpinner('Carregando mangás do AniList', async () => {
    return await fetchAniListMangaWithProgress(cfg.usernameAnilist);
  });

  if (!anilistMangas || anilistMangas.length === 0) {
    ui.NotificationManager.instance.error('Nenhum manga encontrado na sua lista AniList!');
    await prompt([{ name: 'ok', message: 'Pressione Enter para continuar...' }]);
    return;
  }

  // Exibir lista para escolha
  ui.separator('📚 Selecione o Manga');
  console.log(`${ui.colors.muted('Total de mangás na lista:')} ${ui.colors.success(anilistMangas.length)}`);
  console.log('');

  const choiceList = anilistMangas.map((m, i) => ({
    name: `${String(i + 1).padStart(3)}. ${ui.colors.primary(m.title)} ${ui.colors.muted(`[Cap ${m.lastChapterRead}/${m.totalChapters}]`)}`,
    value: i
  }));

  const selected = await prompt([
    {
      type: 'list',
      name: 'idx',
      message: ui.colors.primary('🎯 Escolha o manga'),
      choices: choiceList,
      pageSize: 20
    }
  ]);

  const manga = anilistMangas[selected.idx];
  if (!manga) return;

  ui.separator();
  console.log(`${ui.colors.primary('📖 Manga selecionado:')} ${ui.colors.success(manga.title)}`);
  console.log(`  ${ui.colors.muted('Status AniList:')} ${manga.status}`);
  console.log(`  ${ui.colors.muted('Progresso:')} Cap ${manga.lastChapterRead} de ${manga.totalChapters}`);

  // Buscar capítulos já baixados no Suwayomi
  const downloadedChapters = await ui.withSpinner('Verificando capítulos baixados', async () => {
    // Aqui precisaríamos buscar pelo mangaID no Suwayomi
    // Por enquanto, retorna 0
    return 0;
  });

  console.log(`  ${ui.colors.muted('Baixados no Suwayomi:')} Cap ${downloadedChapters}`);

  // Determinar próximo capítulo disponível
  const nextChapter = Math.max(manga.lastChapterRead, downloadedChapters) + 1;
  const availableChapters = manga.totalChapters - nextChapter + 1;

  if (availableChapters <= 0) {
    ui.NotificationManager.instance.success('Todos os capítulos já baixados!');
    await prompt([{ name: 'ok', message: 'Pressione Enter para continuar...' }]);
    return;
  }

  console.log(`  ${ui.colors.info('👉 Próximo capítulo disponível:')} ${ui.colors.success(nextChapter)}`);
  console.log(`  ${ui.colors.info('Capítulos restantes:')} ${ui.colors.warning(availableChapters)}`);
  console.log('');

  // Escolher modo de download
  const downloadMode = await prompt([
    {
      type: 'list',
      name: 'mode',
      message: `${ui.colors.warning('⚡')} Modo de download`,
      choices: [
        { name: `${ui.colors.success('🚀 ')} AGGRESSIVE - Baixar todos os ${availableChapters} capítulos restantes (max performance)`, value: 'all' },
        { name: `${ui.colors.warning('🎯 ')} MANUAL - Escolher range específico (recomendado)`, value: 'manual' }
      ]
    }
  ]);

  let startChapter, endChapter;

  if (downloadMode.mode === 'all') {
    startChapter = nextChapter;
    endChapter = manga.totalChapters;
  } else {
    // Range manual
    const defaultRange = Math.min(10, availableChapters);
    const rangeAns = await prompt([
      {
        name: 'count',
        message: `${ui.colors.warning('📈')} Quantos capítulos baixar? (1-${Math.min(30, availableChapters)})`,
        default: defaultRange,
        validate: (v) => {
          const n = Number(v);
          return Number.isFinite(n) && n >= 1 && n <= Math.min(30, availableChapters)
            ? true
            : `${ui.colors.error('Erro:')} Digite um numero entre 1 e ${Math.min(30, availableChapters)}`;
        }
      }
    ]);

    const count = Math.max(1, Math.min(Math.min(30, availableChapters), Number(rangeAns.count) || defaultRange));
    startChapter = nextChapter;
    endChapter = nextChapter + count - 1;
  }

  // Confirmar download
  ui.separator('📥 Confirmação');
  console.log(`${ui.colors.primary('Manga:')} ${manga.title}`);
  console.log(`${ui.colors.primary('Range:')} Capítulos ${startChapter} a ${endChapter} (${endChapter - startChapter + 1} caps)`);
  console.log('');

  const confirm = await prompt([
    {
      type: 'confirm',
      name: 'ok',
      message: `${ui.colors.warning('⚠️')} Iniciar download?`,
      default: true
    }
  ]);

  if (!confirm.ok) {
    ui.NotificationManager.instance.info('Download cancelado');
    return;
  }

  // Buscar manga no Suwayomi
  ui.separator('🔍 Buscando no Suwayomi...');
  let mangaInfo = await ui.withSpinner('Procurando manga', async () => {
    return await findMangaInSuwayomiByTitle(manga.title);
  });

  if (!mangaInfo) {
    // Manga não encontrado, perguntar se quer adicionar
    const addChoice = await prompt([
      {
        type: 'list',
        name: 'action',
        message: `${ui.colors.warning('Manga não encontrado na biblioteca')}`,
        choices: [
          { name: `${ui.colors.success('➕ ')} Adicionar à biblioteca e baixar`, value: 'add' },
          { name: `${ui.colors.error('❌ ')} Cancelar`, value: 'cancel' }
        ]
      }
    ]);

    if (addChoice.action === 'cancel') {
      ui.NotificationManager.instance.info('Download cancelado');
      return;
    }

    // Aqui precisaríamos adicionar o manga à biblioteca primeiro
    // Por enquanto, vamos simular que o usuário adicionou manualmente
    ui.NotificationManager.instance.warning('Adicione o manga manualmente na biblioteca do Suwayomi primeiro.');
    ui.NotificationManager.instance.info(`Procure por: ${manga.title}`);
    await prompt([{ name: 'ok', message: 'Pressione Enter após adicionar...' }]);

    // Tentar buscar novamente
    mangaInfo = await ui.withSpinner('Buscando manga adicionado', async () => {
      return await findMangaInSuwayomiByTitle(manga.title);
    });

    if (!mangaInfo) {
      ui.NotificationManager.instance.error('Manga ainda não encontrado. Tente novamente após adicionar manualmente.');
      return;
    }
  }

  // Agora temos o mangaId, enfileirar download
  ui.separator('⬇️ Iniciando Download');
  console.log(`${ui.colors.primary('Manga:')} ${mangaInfo.title}`);
  console.log(`${ui.colors.primary('Fonte:')} ${mangaInfo.sourceName}`);
  console.log(`${ui.colors.primary('Capítulos:')} ${startChapter} - ${endChapter}`);
  console.log('');

  try {
    const result = await ui.withSpinner(`Baixando ${endChapter - startChapter + 1} capítulos`, async () => {
      return await enqueueMangaDownload(mangaInfo.mangaId, startChapter, endChapter, 5);
    });

    ui.NotificationManager.instance.success(`Download enfileirado com sucesso!`);
    console.log(`  ${ui.colors.muted('Manga ID:')} ${mangaInfo.mangaId}`);
    console.log(`  ${ui.colors.muted('Capítulos:')} ${startChapter}-${endChapter}`);
    console.log(`  ${ui.colors.muted('Status:')} ${result ? 'Adicionado à fila' : 'Erro na resposta'}`);
  } catch (e) {
    ui.NotificationManager.instance.error(`Falha ao iniciar download: ${e.message}`);
  }

  await prompt([{ name: 'ok', message: 'Pressione Enter para continuar...' }]);
}

// ============================================================================
// EXPORTS
// ============================================================================

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
  warmAndBuildPreview,
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
  waitForDownloadsAndSyncKomga,
  // Novas funções de download manual
  fetchAniListMangaWithProgress,
  getDownloadedChapterCount,
  enqueueMangaDownload,
  findMangaInSuwayomiByTitle,
  downloadManualMangaUI
};
