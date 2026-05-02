/**
 * Auto-linking operations.
 *
 * Application-level functions for managing manual links, searching candidates,
 * building batch previews, and warming the auto-link cache.
 */
const { loadConfig, saveConfig } = require('../infra/config/config-store');
const { addMangaToLibrary, removeMangaFromLibrary } = require('../infra/server/suwayomi-api');
const {
  makeApiClient,
  listSources,
  searchSource,
  getMangaChapters
} = require('../infra/server/suwayomi-api');
const { loadSuwayomiLibraryIndex } = require('../infra/links/load-suwayomi-library-index');
const { resolveItemLibraryLink } = require('./link-service');
const { linkItemInLibrary } = require('./link-service');
const { unlinkItemFromLibrary } = require('./link-service');
const {
  loadLinkCache,
  saveLinkCache,
  getCachedAutoLink,
  upsertCachedAutoLink,
  getItemProcessKey,
  readListForEnqueue,
  scoreCandidateAgainstItemTitles,
  scoreTwoTitlesForAutoLink,
  buildSearchTermsForItem,
  buildUniqueSearchTermsForLinkResolution,
  reorderSourcesByIds
} = require('../domain/links/auto-link-core');

// ---------------------------------------------------------------------------
// Manual links
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Auto-link candidates
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Batch preview & cache warming
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Manual link resolution & library helpers
// ---------------------------------------------------------------------------

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

module.exports = {
  getManualLinks,
  setManualLink,
  removeManualLink,
  listMangaItemsForManualLink,
  searchManualLinkCandidates,
  getManualLinkRuntimeStatus,
  getAutoLinkCandidates,
  getCachedAutoLinkCandidates,
  buildBatchAutoLinkPreview,
  warmAutoLinkCache,
  // Resolution helpers
  resolveManualLinkAgainstSource,
  getSuwayomiLibraryEntries,
  findBestLibraryLinkForItem,
  isFallbackMatchSafe
};
