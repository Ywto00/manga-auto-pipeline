/**
 * Link resolution core helpers.
 *
 * Pure domain utilities for title matching, link caching, and
 * search-term generation used across the auto-linking pipeline.
 */
const fs = require('fs');
const path = require('path');
const { getListPath, getDownloadsPath, getLinkCachePath } = require('../../../config/infra/config-store');

// ---------------------------------------------------------------------------
// Registry loading
// ---------------------------------------------------------------------------

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

function getItemProcessKey(item) {
  const src = String(item.source || 'unknown');
  const id = String(item.id || '');
  const sk = String(item.searchKey || '');
  return `${src}:${id}:${sk}`;
}

// ---------------------------------------------------------------------------
// Link cache
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Title matching
// ---------------------------------------------------------------------------

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

function reorderSourcesByIds(sources, orderedIds = []) {
  if (!Array.isArray(orderedIds) || !orderedIds.length) return sources;
  const pos = new Map(orderedIds.map((id, i) => [String(id), i]));
  return [...sources].sort((a, b) => {
    const pa = pos.has(String(a.id)) ? pos.get(String(a.id)) : Number.MAX_SAFE_INTEGER;
    const pb = pos.has(String(b.id)) ? pos.get(String(b.id)) : Number.MAX_SAFE_INTEGER;
    return pa - pb;
  });
}

async function getCachedAutoLinkCandidates(item, options = {}) {
  const cfg = loadConfig();
  const signature = buildLinkCacheSignature(item, options, cfg);
  const cached = getCachedAutoLink(item, options, cfg);
  if (cached) {
    return {
      best: cached.best,
      sources: cached.sources,
      cached: true
    };
  }

  // Need to fetch from sources - this would typically use the source search
  // For now, return empty - actual implementation would be in link-cache module
  return {
    best: null,
    sources: [],
    cached: false
  };
}

function computeBestLocalMatch(item, linked) {
  // Simplified version - would use findBestLibraryLinkForItem
  if (!linked) return null;
  // Placeholder
  return { score: 85, matchedAgainst: item.title };
}

module.exports = {
  // Registry
  readListForEnqueue,
  loadDownloadsRegistry,
  getItemProcessKey,

  // Cache
  loadLinkCache,
  saveLinkCache,
  buildLinkCacheSignature,
  getCachedAutoLink,
  upsertCachedAutoLink,

  // Title matching
  normalizeTitleLoose,
  isChapterStrictlyBeforeProgress,
  tokenizeTitleLoose,
  scoreTwoTitlesForAutoLink,
  scoreCandidateAgainstItemTitles,
  buildSearchTermsForItem,
  buildUniqueSearchTermsForLinkResolution,
  reorderSourcesByIds,

  // Auto-link core
  getCachedAutoLinkCandidates,
  computeBestLocalMatch
};
