/**
 * Enqueue domain utilities.
 *
 * Extracted from cli-logic.js to separate concerns:
 *  - buildWantedChapterNumbers
 *  - chaptersAreAlreadyCovered
 *  - getItemProcessKey
 *  - getQueueTitle
 *  - toPercent
 */
const { normalize } = require('../../../shared/utils/normalize');

function buildWantedChapterNumbers(progress, capsAhead) {
  const out = [];
  const p = Number(progress || 0);
  const c = Number(capsAhead || 0);
  const start = p > 0 ? p : 1;
  for (let i = 0; i < c; i += 1) out.push(start + i);
  return out;
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

function getItemProcessKey(item) {
  const src = String(item.source || 'unknown');
  const id = String(item.id || '');
  const sk = String(item.searchKey || normalize(item.title || ''));
  return `${src}:${id}:${sk}`;
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

module.exports = {
  buildWantedChapterNumbers,
  chaptersAreAlreadyCovered,
  getItemProcessKey,
  getQueueTitle,
  toPercent
};
