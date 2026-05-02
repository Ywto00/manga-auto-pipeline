/**
 * Enqueue orchestration flow.
 *
 * Orchestrates smart enqueue with retries, fallback matching, and
 * library duplicate cleanup.
 */
const {
  listSources,
  searchSource,
  addMangaToLibrary,
  getMangaChapters,
  queueChapter,
  startDownloader
} = require('../infra/server/suwayomi-api');

const { searchAndEnqueueCore: searchAndEnqueue } = require('../infra/enqueue/smart-enqueue');
const {
  getCachedAutoLink,
  upsertCachedAutoLink,
  getItemProcessKey,
  reorderSourcesByIds,
  buildSearchTermsForItem,
  getAutoLinkCandidates: _getAutoLinkCandidates
} = require('../domain/links/auto-link-core');
const { getAutoLinkCandidates: _getAutoLinkCandidatesFromService } = require('./auto-link-service');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---- helper functions ----

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
        score: Number((m && m.score) || 0)
      });
    }
  }
  return out;
}

function mangaHasChapters(manga) {
  return Array.isArray(manga && manga.chapters) && manga.chapters.length > 0;
}

async function tryFixedMatchWithRetries(api, item, chapters, priority, base, fixedMatch, retriesPerSource) {
  const attempts = [];
  let lastErr = null;

  for (let i = 1; i <= retriesPerSource; i += 1) {
    try {
      const result = await searchAndEnqueue(
        api,
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

class EnqueueService {
  /**
   * Orchestrates a smart enqueue for a single manga item.
   */
  async runSmartEnqueue(api, item, chapters, priority, options = {}) {
    const {
      dry = false,
      allowedLangs = [],
      sourceOrderIds = [],
      strictTitleMatch = true,
      strictMinScore = 88,
      maxSourcesToTry,
      searchTerms,
      fixedMatch
    } = options;

    // 1. Try to find a cached auto-link
    const cacheKey = getItemProcessKey(item.id || item.searchKey);
    const cached = await getCachedAutoLink(cacheKey);
    if (cached && cached.ok) {
      // If we have a solid cache, we might want to skip the search
      // But let's follow the flow: if it's a fixed match, use it.
    }

    // 2. If we have a fixed match, use it with retries
    if (fixedMatch) {
      const retryResult = await tryFixedMatchWithRetries(
        api,
        item,
        chapters,
        priority,
        { sources: sourceOrderIds, strictTitleMatch, strictMinScore, maxSourcesToTry, searchTerms, fixedMatch },
        fixedMatch,
        3 // default retries
      );
      if (retryResult.ok) return retryResult;
      throw new Error(`Fixed match failed after retries: ${retryResult.error?.message || retryResult.error}`);
    }

    // 3. Normal search and enqueue
    const result = await searchAndEnqueue(
      api,
      item.title || item.searchKey,
      chapters,
      priority,
      {
        sources: sourceOrderIds,
        maxSourcesToTry,
        searchTerms,
        strictTitleMatch,
        strictMinScore
      }
    );

    return { ok: true, result, attempts: [] };
  }

  /**
   * Processes a list of manga items.
   */
  async enqueueFromList(api, items, options = {}) {
    const {
      dry = false,
      priority = [],
      allowedLangs = [],
      sourceOrderIds = [],
      limit = 100,
      onItem = () => {},
    } = options;

    const output = [];
    const stats = {
      eligibleCount: 0,
      skippedAlreadyProcessed: 0,
      processedCount: 0
    };
    const notFound = [];

    for (const item of items.slice(0, limit)) {
      stats.eligibleCount += 1;
      try {
        const result = await this.runSmartEnqueue(api, item, [], priority, {
          sourceOrderIds,
          allowedLangs
        });

        if (result.ok) {
          stats.processedCount += 1;
          output.push({ ok: true, item, result });
        } else {
          output.push({ ok: false, item, error: result.error });
        }
      } catch (err) {
        output.push({ ok: false, item, error: err });
      }
      onItem({ ok: output[output.length - 1].ok, item, result: output[output.length - 1].result, error: output[output.length - 1].error });
    }

    return { output, stats, notFound };
  }
}

module.exports = {
  EnqueueService,
  isHttpStatus,
  isTimeoutError,
  collectFallbackFixedMatches,
  mangaHasChapters,
  tryFixedMatchWithRetries
};
