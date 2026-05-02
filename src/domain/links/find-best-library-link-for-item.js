function findBestLibraryLinkForItem(params) {
  const item = params && params.item ? params.item : {};
  const libraryEntries = Array.isArray(params && params.libraryEntries) ? params.libraryEntries : [];
  const sourceNameById = params && params.sourceNameById instanceof Map ? params.sourceNameById : new Map();
  const strictMinScore = Number(params && params.strictMinScore || 88);
  const scoreCandidate = typeof (params && params.scoreCandidate) === 'function'
    ? params.scoreCandidate
    : (() => ({ score: 0, matchedAgainst: '' }));

  let best = null;
  const primaryInput = String(item.title || item.searchKey || '').trim();
  const primaryLooksDoujinshi = /doujinshi|\bdj\b/i.test(primaryInput);

  for (const row of libraryEntries) {
    if (!row || row.inLibrary === false) continue;

    const mangaId = Number(row.id);
    const mangaTitle = String(row.title || '').trim();
    const sourceId = String(row.sourceId || '').trim();
    if (!Number.isFinite(mangaId) || !mangaTitle || !sourceId) continue;

    const looksDoujinshi = /doujinshi|\bdj\b|fanbook|artbook|anthology/i.test(mangaTitle);
    if (looksDoujinshi && !primaryLooksDoujinshi) continue;

    const scored = scoreCandidate(item, mangaTitle);
    const score = Number(scored && scored.score || 0);
    if (!best || score > Number(best.score || 0)) {
      best = {
        sourceId,
        sourceName: sourceNameById.get(sourceId) || sourceId,
        mangaId,
        mangaTitle,
        score,
        matchedAgainst: String(scored && scored.matchedAgainst || '')
      };
    }
  }

  if (!best || Number(best.score || 0) < strictMinScore) return null;
  return best;
}

module.exports = {
  findBestLibraryLinkForItem
};
