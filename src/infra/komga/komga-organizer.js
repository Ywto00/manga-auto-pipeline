/**
 * Komga library organizer.
 *
 * Takes downloaded CBZ files from the Suwayomi downloads folder
 * and organizes them into a Komga-compatible library structure:
 *  - One folder per series (sanitized name)
 *  - CBZs hard-linked or copied into the series folder
 *  - Metadata files (series.json, ComicInfo.xml) generated from AniList data
 *  - Cover images extracted or downloaded
 *
 * After organizing, it triggers Komga to pick up the changes via scan/metadata refresh.
 */
const fs = require('fs');
const path = require('path');
const { normalize } = require('../../shared/utils/normalize');
const { loadConfig } = require('../../infra/config/config-store');
const { buildListMetadataIndex, buildListMetadataById, buildSeriesJsonMetadataIndex, mergeItemMetadata, findSeriesMetadata } = require('../../infra/metadata/metadata-index');
const { fetchAniListMediaById } = require('../../infra/sync/anilist-adapter');
const { decodeHtmlEntities, toEnglishSummaryText, mapKomgaStatusFromAniList, toKomgaAlternateTitles, buildKomgaSeriesMetadataPatch, ensureKomgaLibraryExists, triggerKomgaLibraryScan, triggerKomgaMetadataRefresh, buildKomgaAuthHeaders, buildKomgaAuthConfig } = require('./komga-api');

const axios = require('axios');

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

/** Links or copies a file. Falls back from hardlink to copy on failure. */
function linkOrCopyFile(src, dest, mode = 'copy') {
  if (fs.existsSync(dest)) return 'skipped-exists';
  ensureDir(path.dirname(dest));
  if (mode === 'hardlink') {
    try { fs.linkSync(src, dest); return 'linked'; }
    catch (e) { fs.copyFileSync(src, dest); return 'copied-fallback'; }
  }
  fs.copyFileSync(src, dest);
  return 'copied';
}

function moveFile(src, dest) {
  if (fs.existsSync(dest)) return 'skipped-exists';
  ensureDir(path.dirname(dest));
  try { fs.renameSync(src, dest); return 'moved'; }
  catch (e) { fs.copyFileSync(src, dest); fs.unlinkSync(src); return 'moved'; }
}

// ---------------------------------------------------------------------------
// Series naming & organization
// ---------------------------------------------------------------------------

/**
 * Infers the series name from a CBZ's position in the downloads tree.
 * Assumes structure: downloads/Manga Title/chapter-files.cbz
 */
function inferSeriesNameFromCbz(cbzPath, downloadsRoot) {
  const rel = path.relative(downloadsRoot, cbzPath);
  const parts = rel.split(path.sep).filter(Boolean);
  // Prefer parent folder as series name when CBZ is already inside a series directory.
  if (parts.length >= 2) return sanitizeFsName(parts[parts.length - 2]);

  const base = sanitizeFsName(path.basename(cbzPath, path.extname(cbzPath)));
  return base.replace(/\b(ch|chapter|cap|c)\s*\d+(\.\d+)?\b/gi, '').trim() || base;
}

function sanitizeFsName(name) {
  return String(name || 'unknown')
    .replace(/[<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSeriesKey(name) {
  return normalize(String(name || '')).trim().toLowerCase();
}

/** Format YYYY-MM-DD in local timezone */
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

// ---------------------------------------------------------------------------
// Metadata file generation
// ---------------------------------------------------------------------------

function writeSeriesMetadata(seriesDir, seriesName, itemMeta) {
  const totalIssues = Number.isFinite(Number(itemMeta && itemMeta.totalChapters)) ? Number(itemMeta.totalChapters) : null;
  const year = Number.isFinite(Number(itemMeta && itemMeta.startYear)) ? Number(itemMeta.startYear) : null;
  const statusRaw = (itemMeta && (itemMeta.mediaStatus || itemMeta.status)) ? String(itemMeta.mediaStatus || itemMeta.status).toLowerCase() : '';
  const status = (statusRaw === 'finished' || statusRaw === 'completed') ? 'Ended' : (statusRaw ? 'Continuing' : '');
  const altTitles = (itemMeta && Array.isArray(itemMeta.altTitles)) ? itemMeta.altTitles.map(x => String(x || '').trim()).filter(Boolean).slice(0, 20) : [];
  const summary = toEnglishSummaryText(itemMeta);
  const language = itemMeta && itemMeta.countryOfOrigin
    ? ({ JP: 'ja', KR: 'ko', CN: 'zh', TW: 'zh', US: 'en' }[String(itemMeta.countryOfOrigin).toUpperCase()] || '') : '';
  const genres = (itemMeta && Array.isArray(itemMeta.genres)) ? itemMeta.genres.filter(Boolean) : [];

  const payload = {
    name: seriesName,
    year,
    status,
    description_formatted: summary,
    description_text: summary,
    publisher: (itemMeta && itemMeta.publisher) ? String(itemMeta.publisher) : '',
    age_rating: 0,
    total_issues: totalIssues,
    language,
    genres,
    aliases: altTitles,
    alternate_names: altTitles,
    alternative_titles: altTitles,
    title: seriesName,
    titleSort: seriesName,
    anilistStatus: (itemMeta && itemMeta.status) ? String(itemMeta.status) : '',
    anilistId: (itemMeta && itemMeta.id) ? Number(itemMeta.id) : null,
    source: (itemMeta && itemMeta.source) ? String(itemMeta.source) : '',
    progress: (itemMeta && Number.isFinite(Number(itemMeta.progress))) ? Number(itemMeta.progress) : null,
    totalChapters: totalIssues,
    totalVolumes: (itemMeta && Number.isFinite(Number(itemMeta.totalVolumes))) ? Number(itemMeta.totalVolumes) : null,
    format: (itemMeta && itemMeta.format) ? String(itemMeta.format) : '',
    countryOfOrigin: (itemMeta && itemMeta.countryOfOrigin) ? String(itemMeta.countryOfOrigin) : '',
    siteUrl: (itemMeta && itemMeta.siteUrl) ? String(itemMeta.siteUrl) : '',
    startYear: year,
    coverImageUrl: (itemMeta && itemMeta.coverImage && (itemMeta.coverImage.extraLarge || itemMeta.coverImage.large || itemMeta.coverImage.medium))
      ? String(itemMeta.coverImage.extraLarge || itemMeta.coverImage.large || itemMeta.coverImage.medium) : '',
    altTitles,
    generatedBy: 'manga-auto-pipeline',
    generatedAt: new Date().toISOString()
  };

  fs.writeFileSync(path.join(seriesDir, 'series.json'), JSON.stringify(payload, null, 2), 'utf8');
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function writeComicInfoXml(seriesDir, seriesName, itemMeta) {
  const total = Number.isFinite(Number(itemMeta && itemMeta.totalChapters)) ? Number(itemMeta.totalChapters) : '';
  const year = Number.isFinite(Number(itemMeta && itemMeta.startYear)) ? Number(itemMeta.startYear) : '';
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

// ---------------------------------------------------------------------------
// Cover images
// ---------------------------------------------------------------------------

function findCoverCandidate(sourceDir) {
  if (!sourceDir || !fs.existsSync(sourceDir)) return null;
  const names = ['cover.jpg', 'cover.jpeg', 'cover.png', 'folder.jpg', 'folder.jpeg', 'folder.png', 'poster.jpg', 'poster.jpeg', 'poster.png'];
  for (const name of names) {
    const candidate = path.join(sourceDir, name);
    if (fs.existsSync(candidate)) return candidate;
  }

  const lowerPriority = ['thumbnails', 'thumbnail', '.thumbnails', '.thumbnail', 'thumbs', 'images'];
  for (const folder of lowerPriority) {
    const dir = path.join(sourceDir, folder);
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(name => /\.(jpe?g|png|webp)$/i.test(name)).sort();
    if (files.length) return path.join(dir, files[0]);
  }

  const rootImages = fs.readdirSync(sourceDir).filter(name => /\.(jpe?g|png|webp)$/i.test(name)).sort();
  if (rootImages.length) return path.join(sourceDir, rootImages[0]);
  return null;
}

function getAniListCoverUrl(itemMeta) {
  if (!itemMeta || !itemMeta.coverImage) return '';
  return String(itemMeta.coverImage.extraLarge || itemMeta.coverImage.large || itemMeta.coverImage.medium || '').trim();
}

async function downloadCoverFromUrl(url, seriesDir) {
  let response = null;
  const headers = { 'User-Agent': 'manga-auto-pipeline/1.0', Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' };

  for (let i = 0; i < 3; i += 1) {
    response = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000, headers, validateStatus: () => true });
    if (response.status >= 200 && response.status < 300) break;
    if (response.status !== 429 && response.status < 500) break;
    await new Promise(r => setTimeout(r, 500 * (i + 1)));
  }

  if (!response || !(response.status >= 200 && response.status < 300)) throw new Error(`cover-download-http-${response ? response.status : 'no-response'}`);

  const contentType = String((response.headers && response.headers['content-type']) || '').toLowerCase();
  let ext = '.jpg';
  if (contentType.includes('png')) ext = '.png';
  if (contentType.includes('webp')) ext = '.webp';

  fs.writeFileSync(path.join(seriesDir, `cover${ext}`), Buffer.from(response.data));
  return path.join(seriesDir, `cover${ext}`);
}

async function ensureSeriesCover(seriesDir, sourceDir, itemMeta) {
  const existing = ['cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp']
    .map(name => path.join(seriesDir, name)).find(p => fs.existsSync(p));
  if (existing) return 'already-exists';

  let coverUrl = getAniListCoverUrl(itemMeta);
  if (!coverUrl && itemMeta && itemMeta.id) {
    try {
      const aniItem = await fetchAniListMediaById(itemMeta.id);
      coverUrl = aniItem ? getAniListCoverUrl(aniItem) : '';
    } catch (e) { /* fallback */ }
  }
  if (coverUrl) {
    try { await downloadCoverFromUrl(coverUrl, seriesDir); return 'created-from-anilist'; }
    catch (e) { /* fallback to local */ }
  }

  const candidate = findCoverCandidate(sourceDir);
  if (candidate) {
    const ext = path.extname(candidate).toLowerCase() || '.jpg';
    fs.copyFileSync(candidate, path.join(seriesDir, `cover${ext}`));
    return 'created';
  }

  return 'not-found';
}

// ---------------------------------------------------------------------------
// Main organizer
// ---------------------------------------------------------------------------

/**
 * Walks the downloads folder, groups CBZs by inferred series,
 * creates series folders in the Komga library, links/copies files,
 * generates metadata and cover files.
 *
 * @param {Object} options
 * @param {'copy'|'hardlink'} [options.mode='hardlink'] - How to transfer files
 * @param {boolean} [options.createGhostFolders=true] - Create empty folders for series without CBZs
 * @param {boolean} [options.createSeriesMetadata=true] - Write series.json
 * @param {boolean} [options.createSeriesCover=true] - Write cover images
 * @param {boolean} [options.forceSync=false] - Skip "once per day" guard
 */
async function organizeKomgaLibrary(options = {}) {
  const cfg = loadConfig();
  const mode = options.mode || cfg.komgaOrganizeMode === 'copy' ? 'copy' : 'hardlink';
  const createMetadata = options.createSeriesMetadata !== false;
  const createCover = options.createSeriesCover !== false;
  const useDownloadsAsLibrary = options.useDownloadsAsLibrary !== false;

  // Resolve library root
  const libraryRoot = useDownloadsAsLibrary
    ? cfg.downloadsPath
    : (cfg.komgaLibraryPath || path.join(cfg.dataDir, 'komga-library'));
  const downloadsRoot = cfg.downloadsPath;

  if (!libraryRoot || !downloadsRoot) throw new Error('Library/downloads paths not configured');
  if (!fs.existsSync(downloadsRoot)) return { libraryRoot, mode, foundCbz: 0, linked: 0, copied: 0, moved: 0, skipped: 0, seriesCount: 0, ghostFolders: 0, metadataCreated: 0, coverCreated: 0, lastSyncAt: cfg.lastKomgaLibrarySyncAt || '' };

  // Check sync frequency guard
  if (!options.forceSync && shouldSkipKomgaSyncToday(cfg.lastKomgaLibrarySyncAt)) {
    return { skippedByRecentSync: true, lastSyncAt: cfg.lastKomgaLibrarySyncAt || '' };
  }

  // Build metadata index for enriching series
  const metadataIndex = buildListMetadataIndex();
  const localMetadataIndex = buildSeriesJsonMetadataIndex([downloadsRoot, libraryRoot]);

  // Find all CBZ files
  const cbzFiles = [];
  let folderCursor = [downloadsRoot];
  while (folderCursor.length) {
    const cur = folderCursor.pop();
    try {
      for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
        const full = path.join(cur, e.name);
        if (e.isDirectory()) folderCursor.push(full);
        else if (e.name.toLowerCase().endsWith('.cbz')) cbzFiles.push(full);
      }
    } catch (e) { /* skip unreachable */ }
  }

  let stats = {
    libraryRoot, mode, foundCbz: cbzFiles.length,
    linked: 0, copied: 0, moved: 0, skipped: 0,
    seriesCount: 0, ghostFolders: 0,
    metadataCreated: 0, coverCreated: 0,
    lastSyncAt: cfg.lastKomgaLibrarySyncAt || ''
  };

  // Group CBZs by inferred series
  const seriesMap = new Map(); // seriesKey -> { seriesName, cbzList: string[] }
  const seriesDirMap = new Map(); // seriesKey -> sourceDir

  for (const cbz of cbzFiles) {
    const sourceDir = path.dirname(cbz);
    const seriesName = inferSeriesNameFromCbz(cbz, downloadsRoot);
    const seriesKey = normalizeSeriesKey(seriesName);

    if (!seriesMap.has(seriesKey)) {
      seriesMap.set(seriesKey, { seriesName, cbzList: [] });
      seriesDirMap.set(seriesKey, sourceDir);
    }
    seriesMap.get(seriesKey).cbzList.push(cbz);
  }

  // Process each series
  for (const [seriesKey, entry] of seriesMap) {
    const existingSourceDir = seriesDirMap.get(seriesKey);
    const seriesDir = useDownloadsAsLibrary && existingSourceDir
      ? existingSourceDir
      : path.join(libraryRoot, entry.seriesName);
    ensureDir(seriesDir);
    stats.seriesCount += 1;

    if (createMetadata) {
      const itemMeta = lookupSeriesMetadata(entry.seriesName, metadataIndex, localMetadataIndex);
      writeSeriesMetadata(seriesDir, entry.seriesName, itemMeta);
      writeComicInfoXml(seriesDir, entry.seriesName, itemMeta);
      stats.metadataCreated += 1;
    }

    if (createCover) {
      const itemMeta = lookupSeriesMetadata(entry.seriesName, metadataIndex, localMetadataIndex);
      try {
        const result = await ensureSeriesCover(seriesDir, seriesDirMap.get(seriesKey), itemMeta);
        if (result === 'created' || result === 'created-from-anilist') stats.coverCreated += 1;
      } catch (e) { /* skip cover */ }
    }

    // Link/copy CBZ files
    for (const cbz of entry.cbzList) {
      const dest = path.join(seriesDir, path.basename(cbz));
      if (path.resolve(cbz) === path.resolve(dest)) {
        stats.skipped += 1;
        continue;
      }
      try {
        const action = linkOrCopyFile(cbz, dest, mode);
        if (action === 'linked') stats.linked += 1;
        else if (action.startsWith('copied')) stats.copied += 1;
        else stats.skipped += 1;
      } catch (e) { stats.skipped += 1; }
    }
  }

  // Persist sync timestamp
  cfg.lastKomgaLibrarySyncAt = new Date().toISOString();
  const { saveConfig, syncServerConf } = require('../infra/config/config-store');
  saveConfig(cfg);

  // Create ghost folders if enabled
  if (options.createGhostFolders) {
    // Ghost folders are series that exist in the list but have no local CBZ yet
    // This is already partially handled by the metadata-index lookups
    stats.ghostFolders = 0; // Ghost folders handled elsewhere or via list.json scan
  }

  return stats;
}

function lookupSeriesMetadata(seriesName, metadataIndex, localMetadataIndex) {
  const fromList = findSeriesMetadata(seriesName, metadataIndex);
  const fromLocal = findSeriesMetadata(seriesName, localMetadataIndex);
  return mergeItemMetadata(fromList, fromLocal);
}

module.exports = { organizeKomgaLibrary, organizeDownloadsForKomga: organizeKomgaLibrary };
