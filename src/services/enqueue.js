const { loadConfig } = require('./config-store');
const { makeApiClient, listSources } = require('../features/server/infra/suwayomi-api');
const { runSmartEnqueueFlow } = require('../features/enqueue/application/enqueue-flow');
const { buildWantedChapterNumbers } = require('../features/enqueue/domain/enqueue-utils');
const {
  readListForEnqueue,
  getItemProcessKey,
  buildSearchTermsForItem,
  reorderSourcesByIds
} = require('../features/links/domain/auto-link-core');
const { resolveEnqueuePrefs } = require('../features/pipeline/application/resolve-enqueue-prefs');
const { getManualLinks, setManualLink } = require('./autolink');

class EnqueueService {
  constructor() {
  }

  async enqueueFromList(opts = {}) {
    const cfg = loadConfig();
    const prefs = resolveEnqueuePrefs(cfg);
    const prepared = readListForEnqueue();

    const keyFilter = Array.isArray(opts.itemKeysFilter) && opts.itemKeysFilter.length
      ? new Set(opts.itemKeysFilter.map(String))
      : null;

    const effectiveList = prepared.list.filter((item) => {
      if (!keyFilter) return true;
      return keyFilter.has(getItemProcessKey(item));
    });

    const limit = Math.max(1, Number(opts.limit || effectiveList.length || 1));
    const queue = effectiveList.slice(0, limit);

    const output = [];
    const notFound = [];

    for (const item of queue) {
      const row = await this.runSmartEnqueue(item, {
        ...opts,
        cfg,
        priority: Array.isArray(opts.priority) ? opts.priority : prefs.priority,
        allowedLangs: Array.isArray(opts.allowedLangs) ? opts.allowedLangs : prefs.allowedLangs,
        sourceOrderIds: Array.isArray(opts.sourceOrderIds) ? opts.sourceOrderIds : prefs.sourceOrderIds,
        capsAhead: Number(opts.capsAhead || cfg.capsAhead || 5)
      });

      if (row.ok) {
        const resultRow = { item, ok: true, result: row.result };
        output.push(resultRow);
        if (typeof opts.onItem === 'function') opts.onItem(resultRow);
        continue;
      }

      const failRow = {
        item,
        ok: false,
        error: row.error,
        code: row.code,
        details: row.details,
        report: row.report
      };
      output.push(failRow);
      if (typeof opts.onItem === 'function') opts.onItem(failRow);

      if (String(row.code || '') === 'NO_MATCH') {
        notFound.push({
          title: String(item && item.title || item && item.searchKey || 'unknown'),
          details: row.details || {}
        });
      }
    }

    const successCount = output.filter(x => x.ok).length;

    return {
      output,
      stats: {
        eligibleCount: prepared.list.length,
        skippedAlreadyProcessed: 0,
        processedCount: queue.length,
        successCount,
        failedCount: output.length - successCount
      },
      notFound
    };
  }

  async runSmartEnqueue(item, opts = {}) {
    const cfg = opts.cfg || loadConfig();
    const apiUrl = cfg.apiUrl || 'http://localhost:4567';
    const timeout = Math.max(5000, Number(cfg.apiTimeoutMs || 30000));
    const client = makeApiClient(apiUrl, { timeout });

    const prefs = resolveEnqueuePrefs(cfg);
    const rawSources = Array.isArray(opts.sources) && opts.sources.length
      ? opts.sources
      : await listSources(client);

    const allowedLangs = Array.isArray(opts.allowedLangs) ? opts.allowedLangs : prefs.allowedLangs;
    const langSet = new Set((allowedLangs || []).map(x => String(x || '').toLowerCase()).filter(Boolean));
    let sources = rawSources;
    if (langSet.size > 0) {
      const filtered = rawSources.filter(s => langSet.has(String(s.lang || '').toLowerCase()));
      if (filtered.length) sources = filtered;
    }

    const sourceOrderIds = Array.isArray(opts.sourceOrderIds) ? opts.sourceOrderIds : prefs.sourceOrderIds;
    sources = reorderSourcesByIds(sources, sourceOrderIds);

    const chapters = Array.isArray(opts.chapters) && opts.chapters.length
      ? opts.chapters.map(Number).filter(Number.isFinite)
      : buildWantedChapterNumbers(item && item.progress, Number(opts.capsAhead || cfg.capsAhead || 5));

    const manualLinks = getManualLinks(cfg);
    const currentFixedMatch = manualLinks[getItemProcessKey(item)] || null;
    const searchTerms = Array.isArray(opts.searchTerms) && opts.searchTerms.length
      ? opts.searchTerms
      : buildSearchTermsForItem(item);
    const priority = Array.isArray(opts.priority) ? opts.priority : prefs.priority;

    const context = {
      cfg,
      sources,
      searchTerms,
      currentFixedMatch,
      sourceOrderIds,
      allowedLangs
    };

    try {
      const run = await runSmartEnqueueFlow(client, item, chapters, priority, context);
      if (!run.ok) {
        const err = run.error || new Error('smart-enqueue-failed');
        return {
          ok: false,
          error: err.message,
          code: err.code || '',
          details: err.details || null,
          report: run.report || err.report || null
        };
      }

      const result = {
        ...run.result,
        report: run.report || null,
        requestedChapters: chapters
      };

      if (
        result &&
        result.fallbackUsed &&
        cfg.persistSwitchedSourceLink !== false &&
        result.source &&
        result.manga
      ) {
        try {
          await setManualLink(item, {
            sourceId: String(result.source.id),
            sourceName: result.source.name || String(result.source.id),
            mangaId: Number(result.manga.id),
            mangaTitle: String(result.manga.title || item.title || item.searchKey || '')
          });
          result.linkUpdated = true;
        } catch (e) {
          result.linkUpdated = false;
        }
      }

      return { ok: true, result };
    } catch (error) {
      return {
        ok: false,
        error: error.message,
        code: error.code || '',
        details: error.details || null,
        report: error.report || null
      };
    }
  }

  buildWantedChapters(progress, capsAhead = 5) {
    return buildWantedChapterNumbers(progress, capsAhead);
  }
}

module.exports = { EnqueueService };