const { findBestLibraryLinkForItem } = require('../domain/find-best-library-link-for-item');

async function unlinkItemFromLibrary(params) {
  const client = params && params.client;
  const removeMangaFromLibrary = params && params.removeMangaFromLibrary;
  const item = params && params.item ? params.item : {};
  const libraryEntries = Array.isArray(params && params.libraryEntries) ? params.libraryEntries : [];
  const sourceNameById = params && params.sourceNameById instanceof Map ? params.sourceNameById : new Map();
  const strictMinScore = Number(params && params.strictMinScore || 88);
  const scoreCandidate = params && params.scoreCandidate;

  const linked = findBestLibraryLinkForItem({
    item,
    libraryEntries,
    sourceNameById,
    strictMinScore,
    scoreCandidate
  });

  if (!linked || !Number.isFinite(Number(linked.mangaId))) return false;
  return removeMangaFromLibrary(client, Number(linked.mangaId));
}

module.exports = {
  unlinkItemFromLibrary
};
