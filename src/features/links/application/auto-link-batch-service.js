/**
 * Batch auto-linking operations.
 *
 * Provides utilities for batch processing of auto-links:
 * - Preview generation for batch matching
 * - Cache warming for performance
 * - Source health checking
 * - Transparency metrics
 * - Selected links persistence
 */
const { loadConfig } = require('../../../config/infra/config-store');
const { loadLinkCache, saveLinkCache, getItemProcessKey, buildLinkCacheSignature } = require('../../../features/links/domain/auto-link-core');
const { getCachedAutoLinkCandidates } = require('../../../features/links/domain/find-best-library-link-for-item');
const { makeApiClient, listSources, searchSource } = require('../../../features/server/infra/suwayomi-api');
const { readListForEnqueue } = require('../domain/auto-link-core');

function computeBatchTransparency(previewRows, minScore) {
  const withSuggestion = previewRows.filter(r => r.best).length;
  const withoutSuggestion = previewRows.length - withSuggestion;
  const belowScore = previewRows.filter(r => r.best && Number(r.best.score || 0) < minScore).length;
  const acceptedByRule = previewRows.filter(r => r.best && Number(r.best.score || 0) >= minScore).length;
  return {
    total: previewRows.length,
    withSuggestion,
    withoutSuggestion,
    belowScore,
    acceptedByRule
  };
}

function collectAutoSelectedKeys(previewRows, minScore) {
  return previewRows
    .filter(r => r.best && Number(r.best.score || 0) >= minScore)
    .map(r => String(r.key));
}

async function saveSelectedLinks(previewRows, selectedKeys, deps) {
  const setManualLink = deps.setManualLink;
  let savedCount = 0;

  for (const row of previewRows) {
    if (!row.best) continue;
    if (!selectedKeys.includes(String(row.key))) continue;

    await setManualLink(row.item, {
      sourceId: row.best.sourceId,
      sourceName: row.best.sourceName,
      mangaId: row.best.mangaId,
      mangaTitle: row.best.mangaTitle
    });
    savedCount += 1;
  }

  return savedCount;
}

async function warmAutoLinkCache(options = {}) {
  const {
    onlyUnlinked = false,
    limit = 100,
    concurrency = 10,
    maxSourcesToTry,
    searchConcurrency,
    forceRefresh = false,
    cacheOnly = false,
    verifyChapters = true,
    onProgress = null
  } = options;

  const cfg = loadConfig();
  const apiUrl = cfg.apiUrl || 'http://localhost:4567';
  const client = makeApiClient(apiUrl);
  const sources = await listSources(client);
  const effectiveLangs = (Array.isArray(cfg.preferredSearchLangs) ? cfg.preferredSearchLangs : []);
  const langSet = new Set(effectiveLangs.map(x => String(x || '').toLowerCase()).filter(Boolean));
  let filteredSources = sources;
  if (langSet.size > 0) {
    filteredSources = sources.filter(s => langSet.has(String(s.lang || '').toLowerCase()));
  }
  const sourcesToUse = filteredSources.slice(0, maxSourcesToTry || cfg.maxExtensionsForAutoLink || 12);

  const cache = loadLinkCache();
  let total = 0;
  let withBest = 0;
  let cacheHits = 0;
  let errors = 0;
  const processed = new Set();

  const { list } = readListForEnqueue();
  let items = list;
  items = items.slice(0, limit);

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    await Promise.all(batch.map(async (item) => {
      try {
        const itemKey = getItemProcessKey(item);
        if (processed.has(itemKey)) return;
        processed.add(itemKey);

        const existing = cache.items[itemKey];
        if (existing && !forceRefresh) {
          cacheHits += 1;
          if (existing.best) withBest += 1;
          return;
        }

        const preview = await getCachedAutoLinkCandidates(item, {
          maxSourcesToTry: sourcesToUse.length,
          verifyChapters: verifyChapters
        });

        if (preview.best) withBest += 1;

        cache.items[itemKey] = {
          updatedAt: new Date().toISOString(),
          best: preview.best,
          sources: preview.sources
        };
        total += 1;
      } catch (e) {
        errors += 1;
      }
    }));

    if (onProgress) {
      onProgress({
        done: Math.min(i + concurrency, items.length),
        total: items.length,
        withBest,
        cacheHits,
        errors
      });
    }
  }

  saveLinkCache(cache);

  return {
    total: processed.size,
    withBest,
    cacheHits,
    errors
  };
}

async function buildBatchAutoLinkPreview(options = {}) {
  const {
    onlyUnlinked = false,
    limit = 100,
    concurrency = 10,
    maxSourcesToTry,
    searchConcurrency,
    verifyChapters = true,
    useCache = true,
    forceRefresh = false,
    cacheOnly = false
  } = options;

  const cfg = loadConfig();
  const apiUrl = cfg.apiUrl || 'http://localhost:4567';
  const client = makeApiClient(apiUrl);
  const sources = await listSources(client);
  const effectiveLangs = (Array.isArray(cfg.preferredSearchLangs) ? cfg.preferredSearchLangs : []);
  const langSet = new Set(effectiveLangs.map(x => String(x || '').toLowerCase()).filter(Boolean));
  let filteredSources = sources;
  if (langSet.size > 0) {
    filteredSources = sources.filter(s => langSet.has(String(s.lang || '').toLowerCase()));
  }
  const sourcesToUse = filteredSources.slice(0, maxSourcesToTry || cfg.maxExtensionsForAutoLink || 12);

  const cache = loadLinkCache();
  const { list } = readListForEnqueue();
  let items = list;
  items = items.slice(0, limit);

  const previewRows = [];

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(async (item) => {
      try {
        const itemKey = getItemProcessKey(item);

        const existing = cache.items[itemKey];
        if (useCache && existing && !forceRefresh) {
          return {
            key: itemKey,
            item,
            best: existing.best || null,
            sources: existing.sources || [],
            cached: true
          };
        }

        if (cacheOnly) {
          return {
            key: itemKey,
            item,
            best: null,
            sources: [],
            cached: false
          };
        }

        const preview = await getCachedAutoLinkCandidates(item, {
          maxSourcesToTry: sourcesToUse.length,
          verifyChapters: verifyChapters
        });

        return {
          key: itemKey,
          item,
          best: preview.best || null,
          sources: preview.sources || [],
          cached: false
        };
      } catch (e) {
        return {
          key: getItemProcessKey(item),
          item,
          best: null,
          sources: [],
          error: e.message
        };
      }
    }));

    previewRows.push(...results);
  }

  return previewRows;
}

async function checkSourcesHealth(options = {}) {
  const {
    maxSourcesToTry = 12,
    probeTerm = 'one piece'
  } = options;

  const cfg = loadConfig();
  const apiUrl = cfg.apiUrl || 'http://localhost:4567';
  const client = makeApiClient(apiUrl);
  const sources = await listSources(client);
  const sourcesToCheck = sources.slice(0, maxSourcesToTry);

  const results = [];

  for (const source of sourcesToCheck) {
    try {
      const searchRes = await searchSource(client, source.id, probeTerm, { perPage: 5 });
      const sampleResults = Array.isArray(searchRes) ? searchRes.length : 0;
      results.push({
        sourceName: source.name,
        sourceId: source.id,
        lang: source.lang,
        ok: true,
        sampleResults,
        httpStatus: 200
      });
    } catch (e) {
      const status = e.response && e.response.status;
      results.push({
        sourceName: source.name,
        sourceId: source.id,
        lang: source.lang,
        ok: false,
        error: e.message,
        httpStatus: status || null
      });
    }
  }

  const ok = results.filter(r => r.ok).length;
  const failed = results.length - ok;

  return {
    total: results.length,
    ok,
    failed,
    rows: results
  };
}

async function warmAndBuildPreview(opts = {}, deps = {}) {
  const warm = await warmAutoLinkCache(opts);
  const previewRows = await buildBatchAutoLinkPreview(opts);
  return { warm, previewRows };
}

module.exports = {
  computeBatchTransparency,
  collectAutoSelectedKeys,
  saveSelectedLinks,
  warmAndBuildPreview,
  buildBatchAutoLinkPreview,
  warmAutoLinkCache,
  checkSourcesHealth
};
