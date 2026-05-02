/**
 * Smart enqueue engine.
 *
 * The heart of the pipeline: searches Suwayomi sources for manga matching
 * the user's AniList items, selects chapters based on reading progress,
 * and queues downloads.
 *
 * This module contains:
 *  - searchAndEnqueueCore: the core search+enqueue logic
 *  - Chapter selection by number
 *  - Want chapter range calculation based on AniList progress
 */
const {
  listSources,
  searchSource,
  addMangaToLibrary,
  getMangaChapters,
  queueChapter,
  startDownloader
} = require('../server/suwayomi-api');

const {
  scoreCandidateAgainstInputs,
  buildUniqueMatchInputs,
  sortSourcesByPriority,
  sourceMatchesAnyPriority,
  findSourceById
} = require('../../domain/links/title-match-core');

// ---------------------------------------------------------------------------
// Chapter selection
// ---------------------------------------------------------------------------

/**
 * Picks chapter indexes whose chapterNumber best matches the wanted numbers.
 * Safe: never picks chapters that are already downloaded.
 *
 * @param {{ index: string|number, chapterNumber: string|number, downloaded: boolean }[]} chapters
 * @param {number[]} wantedNumbers - target chapter numbers (e.g. [211, 212, 213])
 * @returns {number[]} array of chapter index IDs
 */
function pickChapterIndexesByNumber(chapters, wantedNumbers) {
  const remaining = chapters
    .filter(ch => Number.isFinite(Number(ch.index)))
    .map(ch => ({
      index: Number(ch.index),
      chapterNumber: Number(ch.chapterNumber),
      downloaded: Boolean(ch.downloaded)
    }));

  const picked = new Set();
  for (const wanted of wantedNumbers) {
    let best = null;
    let bestDelta = Number.POSITIVE_INFINITY;

    for (const ch of remaining) {
      if (picked.has(ch.index) || ch.downloaded) continue;
      const n = Number(ch.chapterNumber);
      if (!Number.isFinite(n)) continue;

      const delta = Math.abs(n - wanted);
      if (delta < bestDelta) { bestDelta = delta; best = ch; }
    }

    // Safety: never pick a chapter whose number differs by more than 0.51
    if (best && bestDelta <= 0.51) picked.add(best.index);
  }

  return [...picked];
}

/**
 * Calculates which chapter numbers to enqueue based on
 * the user's AniList reading progress and "caps ahead" setting.
 *
 * Example: progress=210, capsAhead=3 -> wants [211, 212, 213]
 */
function buildWantedChapterNumbers(progress, capsAhead) {
  const out = [];
  const p = Number(progress || 0);
  const c = Number(capsAhead || 0);
  const start = p > 0 ? p : 1;
  for (let i = 0; i < c; i += 1) out.push(start + i);
  return out;
}

// ---------------------------------------------------------------------------
// High-level search + enqueue
// ---------------------------------------------------------------------------

/**
 * Searches Suwayomi sources for a manga by title, adds it to the library,
 * and queues the requested chapters for download.
 *
 * @param {Object} api - Suwayomi API client
 * @param {string} searchKey - The title to search for
 * @param {number[]} chapters - Chapter numbers to enqueue
 * @param {string[]} sourcePriority - Ordered list of preferred source names
 * @param {Object} options
 * @param {{ mangaId: number, sourceId: string, mangaTitle: string }|null} [options.fixedMatch] - Forced manual link
 * @param {string[]} [options.searchTerms] - Alternative search terms
 * @param {Object[]} [options.sources] - Pre-fetched source list
 * @param {boolean} [options.strictTitleMatch=true]
 * @param {number} [options.strictMinScore=88]
 * @param {number} [options.maxSourcesToTry]
 * @returns {Promise<{ source: Object, manga: Object, queuedChapterIndexes: number[], requestedChapters: number[], searchedSources: number, sourceErrors: Object[], matchedWithTerm: string, matchedAgainst: string }>}
 */
async function searchAndEnqueueCore(api, searchKey, chapters = [], sourcePriority = [], options = {}) {
  const allSources = (Array.isArray(options.sources) && options.sources.length)
    ? options.sources
    : await listSources(api);
  if (!Array.isArray(allSources) || allSources.length === 0) {
    throw new Error('No installed sources found. Install at least one extension first.');
  }

  let best = null;
  let searchedSources = 0;
  const sourceErrors = [];
  const suggestionsBySource = [];
  const inputLooksDoujinshi = /doujinshi|dj\b/i.test(String(searchKey || ''));
  const strictTitleMatch = options.strictTitleMatch !== false;
  const strictMinScore = Number(options.strictMinScore || 88);

  if (options.fixedMatch && options.fixedMatch.mangaId != null) {
    best = await tryFixedMatch(api, searchKey, allSources, options, strictTitleMatch, strictMinScore);
    searchedSources = 1;
  } else {
    // Normal search: iterate sources by priority
    const prioritized = sortSourcesByPriority(allSources, sourcePriority);
    const prefs = (sourcePriority || []).map(p => String(p || '').trim()).filter(Boolean);
    const preferredOnly = prefs.length ? prioritized.filter(s => sourceMatchesAnyPriority(s, prefs)) : prioritized;
    const fallback = prefs.length ? prioritized.filter(s => !sourceMatchesAnyPriority(s, prefs)) : [];
    const sourceCandidates = preferredOnly.concat(fallback);
    const maxSourcesToTry = Number(options.maxSourcesToTry || sourceCandidates.length || 25);
    const searchTerms = Array.isArray(options.searchTerms) && options.searchTerms.length ? options.searchTerms : [searchKey];
    const matchInputs = buildUniqueMatchInputs(searchKey, searchTerms);

    for (const source of sourceCandidates.slice(0, maxSourcesToTry)) {
      try {
        searchedSources += 1;
        let sourceSuggestion = null;

        for (const term of searchTerms) {
          const page = await searchSource(api, source.id, term, 1);
          const mangaList = Array.isArray(page && page.mangaList) ? page.mangaList : [];

          if (!sourceSuggestion && mangaList.length) {
            sourceSuggestion = {
              sourceId: String(source.id),
              sourceName: source.name || String(source.id),
              lang: source.lang || '',
              titles: mangaList.slice(0, 5).map(x => x && x.title).filter(Boolean)
            };
          }
          if (!mangaList.length) continue;

          for (const manga of mangaList) {
            const candidateTitle = String((manga && manga.title) || '');
            const candidateLooksDoujinshi = /doujinshi|dj\b/i.test(candidateTitle);
            if (!inputLooksDoujinshi && candidateLooksDoujinshi) continue;

            const bestMatch = scoreCandidateAgainstInputs(matchInputs, candidateTitle, strictTitleMatch, strictMinScore);
            if (strictTitleMatch && !bestMatch.strictOk) continue;

            const score = bestMatch.score;
            if (!best || score > best.score) {
              best = { source, manga, score, term, matchedAgainst: bestMatch.matchedAgainst };
            }
          }
          if (best && best.score >= 95) break;
        }

        if (sourceSuggestion) suggestionsBySource.push(sourceSuggestion);
        if (best && best.score >= 95) break;
      } catch (e) {
        sourceErrors.push({ source: source.name || source.id, error: e.message });
      }
    }
  }

  if (!best || !best.manga || !best.manga.id) {
    const suffix = sourceErrors.length
      ? ` | source errors: ${sourceErrors.slice(0, 3).map(x => `${x.source}: ${x.error}`).join(' ; ')}`
      : '';
    const err = new Error(`No matching source found for: ${searchKey} (sources tried: ${searchedSources})${suffix}`);
    err.code = 'NO_MATCH';
    err.details = { searchKey, searchedSources, sourceErrors, suggestionsBySource };
    throw err;
  }

  const mangaId = Number(best.manga.id);
  await addMangaToLibrary(api, mangaId);
  const chapterList = await getMangaChapters(api, mangaId, true);
  const chapterIndexes = pickChapterIndexesByNumber(chapterList, chapters.map(Number).filter(Number.isFinite));

  if (!chapterIndexes.length) {
    return {
      source: best.source, manga: best.manga,
      queuedChapterIndexes: [], requestedChapters: chapters,
      searchedSources, sourceErrors,
      matchedWithTerm: best.term, matchedAgainst: best.matchedAgainst || '',
      alreadyQueuedOrDownloaded: true
    };
  }

  for (const chapterIndex of chapterIndexes) await queueChapter(api, mangaId, chapterIndex);
  await startDownloader(api);

  return {
    source: best.source, manga: best.manga,
    queuedChapterIndexes: chapterIndexes, requestedChapters: chapters,
    searchedSources, sourceErrors,
    matchedWithTerm: best.term, matchedAgainst: best.matchedAgainst || ''
  };
}

/**
 * Handles the fixed-match (manual link) path with validation.
 */
async function tryFixedMatch(api, searchKey, allSources, options, strictTitleMatch, strictMinScore) {
  const fixedSourceId = options.fixedMatch.sourceId != null ? String(options.fixedMatch.sourceId) : '';
  const fixedMangaId = Number(options.fixedMatch.mangaId);

  let fixedSource = findSourceById(allSources, fixedSourceId);
  if (!fixedSource) {
    const fullSources = await listSources(api);
    fixedSource = findSourceById(fullSources, fixedSourceId);
  }
  if (!fixedSource) {
    const err = new Error(`Manual mapping source not found for: ${searchKey} (sourceId=${fixedSourceId})`);
    err.code = 'MAPPING_SOURCE_NOT_FOUND';
    throw err;
  }

  if (!Number.isFinite(fixedMangaId)) {
    const err = new Error(`Manual mapping mangaId is invalid for: ${searchKey}`);
    err.code = 'MAPPING_MANGA_INVALID';
    throw err;
  }

  const searchTerms = Array.isArray(options.searchTerms) && options.searchTerms.length ? options.searchTerms : [searchKey];
  const matchInputs = buildUniqueMatchInputs(searchKey, searchTerms);
  let runtimeTitle = String(options.fixedMatch.mangaTitle || searchKey || '').trim();

  try {
    const { getMangaInfo } = require('../../server/infra/suwayomi-api');
    const info = await getMangaInfo(api, fixedMangaId);
    const titleFromApi = String(info && info.title || '').trim();
    if (titleFromApi) runtimeTitle = titleFromApi;
  } catch (e) { /* keep validating with saved title */ }

  const inputLooksDoujinshi = /doujinshi|dj\b/i.test(String(searchKey || ''));
  const titleLooksDoujinshi = /doujinshi|dj\b|fanbook|artbook|anthology/i.test(runtimeTitle);
  if (!inputLooksDoujinshi && titleLooksDoujinshi) {
    const err = new Error(`Manual link appears stale/suspicious for: ${searchKey} -> ${runtimeTitle}`);
    err.code = 'MANUAL_LINK_SUSPICIOUS';
    throw err;
  }

  const evaluated = scoreCandidateAgainstInputs(matchInputs, runtimeTitle, strictTitleMatch, strictMinScore);
  if (strictTitleMatch && !evaluated.strictOk) {
    const err = new Error(`Manual link title no longer matches item: ${searchKey} -> ${runtimeTitle}`);
    err.code = 'MANUAL_LINK_MISMATCH';
    throw err;
  }

  return {
    source: fixedSource,
    manga: { id: fixedMangaId, title: runtimeTitle || options.fixedMatch.mangaTitle || searchKey },
    score: Number(evaluated.score || 100),
    term: 'manual-link',
    matchedAgainst: evaluated.matchedAgainst || ''
  };
}

module.exports = { searchAndEnqueueCore, pickChapterIndexesByNumber, buildWantedChapterNumbers };
