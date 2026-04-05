/**
 * Enqueue orchestration flow.
 *
 * Orchestrates smart enqueue with retries, fallback matching, and
 * library duplicate cleanup.
 *
 * Extracted from cli-logic.js.
 */
const {
  makeApiClient,
  listSources,
  searchSource,
  getMangaChapters,
  queueChapter,
  removeMangaFromLibrary
} = require('../../server/infra/suwayomi-api');

const { searchAndEnqueueCore: searchAndEnqueue } = require('../infra/smart-enqueue');

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

// Internal helpers needed by enqueue flow (title scoring, etc.)

function normalizeTitleLoose(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

const { scoreCandidateAgainstItemTitles } = require('../../links/domain/auto-link-core');

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

  return { ok: true, reason: '', overallScore, primaryScore, matchedAgainst: overall.matchedAgainst ? overall.matchedAgainst : '' };
}

function buildUniqueSearchTermsForLinkResolution(item, linked, fallbackTerms) {
  const out = [];
  const push = function(v) {
    const s = String(v || '').trim();
    if (!s) return;
    if (!out.some(function(x) { return x.toLowerCase() === s.toLowerCase(); })) out.push(s);
  };

  push(linked && linked.mangaTitle);
  push(item && item.title);
  (Array.isArray(item && item.altTitles) ? item.altTitles : []).forEach(push);
  (Array.isArray(fallbackTerms) ? fallbackTerms : []).forEach(push);
  push(item && item.searchKey);

  return out.slice(0, 10);
}

async function resolveManualLinkAgainstSource(client, item, linked, options) {
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
    } catch (e) { /* online resolve failed, continue */ }
  }

  if (!allowOnlineResolve) {
    return { ok: false, reason: 'score-insuficiente-para-vinculo-manual', strictMinScore };
  }

  let bestOnline = null;
  for (const term of terms) {
    try {
      const page = await searchSource(client, sourceId, term, 1);
      const mangaList = Array.isArray(page && page.mangaList) ? page.mangaList : [];
      for (const m of mangaList) {
        const id = Number(m && m.id);
        if (!Number.isFinite(id) || Number(id) !== linkedMangaId) continue;
        const title = String(m && m.title || '').trim();
        const scored = scoreCandidateAgainstItemTitles(item, title);
        if (Number(scored.score || 0) >= strictMinScore) {
          const entry = {
            sourceId,
            sourceName: source.name || sourceId,
            mangaId: id,
            mangaTitle: title,
            score: Number(scored.score || 0),
            matchedAgainst: scored.matchedAgainst || ''
          };
          if (!bestOnline || entry.score > bestOnline.score) {
            bestOnline = entry;
          }
        }
      }
    } catch (e) { /* ignore */ }
  }

  if (!bestOnline) {
    return { ok: false, reason: 'no-online-match-found', searchedTerms: terms };
  }

  return { ok: true, link: bestOnline };
}

async function getSuwayomiLibraryEntries(client, context) {
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

// ---- getAutoLinkCandidates (also needs to be here since runSmartEnqueueFlow uses it) ----

const {
  getCachedAutoLink,
  upsertCachedAutoLink,
  buildLinkCacheSignature,
  getItemProcessKey,
  reorderSourcesByIds,
  buildSearchTermsForItem
} = require('../../links/domain/auto-link-core');
const { getAutoLinkCandidates: _getAutoLinkCandidates } = require('../links/application/auto-link');
const fs = require('fs');
const path = require('path');
const { getConfigPath, getListPath, getDownloadsPath, getLinkCachePath, loadConfig, saveConfig } = require('../../config/infra/config-store');

// ---- tryFixedMatchWithRetries ----

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

// ---- runSmartEnqueueFlow ----

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

    const cfg = context.cfg;
    const preview = await _getAutoLinkCandidates(item, {
      maxSourcesToTry: Number(cfg.maxExtensionsForAutoLink || cfg.maxSourcesToTryForSearch || 12),
      sourceOrderIds: context.sourceOrderIds || [],
      allowedLangs: context.allowedLangs || [],
      forceRefresh: true,
      useCache: true,
      verifyChapters: true
    });
    const ignore = new Set([`${String(linked.sourceId)}:${Number(linked.mangaId)}`]);
    const fallbackMatches = collectFallbackFixedMatches(preview, ignore);

    for (const fixed of fallbackMatches) {
      const safe = isFallbackMatchSafe(item, fixed, cfg);
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

// ---- tryFallbackEnqueueAfter500 ----

async function tryFallbackEnqueueAfter500(client, item, chapters, priority, options) {
  const cfg = options.cfg || loadConfig();
  const ignoreSet = new Set();
  if (options.currentFixedMatch && options.currentFixedMatch.sourceId != null && options.currentFixedMatch.mangaId != null) {
    ignoreSet.add(`${String(options.currentFixedMatch.sourceId)}:${Number(options.currentFixedMatch.mangaId)}`);
  }

  const preview = await _getAutoLinkCandidates(item, {
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

// ---- cleanupLibraryDuplicatesForItem ----

async function cleanupLibraryDuplicatesForItem(client, item, keepMatch, options) {
  options = options || {};
  if (!keepMatch || keepMatch.sourceId == null || keepMatch.mangaId == null) {
    return { attempted: 0, removed: 0, failed: 0 };
  }

  const keepKey = `${String(keepMatch.sourceId)}:${Number(keepMatch.mangaId)}`;
  const preview = await _getAutoLinkCandidates(item, {
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

module.exports = {
  isHttpStatus,
  isTimeoutError,
  collectFallbackFixedMatches,
  mangaHasChapters,
  tryFixedMatchWithRetries,
  runSmartEnqueueFlow,
  tryFallbackEnqueueAfter500,
  cleanupLibraryDuplicatesForItem
};
