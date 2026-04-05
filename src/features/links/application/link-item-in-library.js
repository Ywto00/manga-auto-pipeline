async function linkItemInLibrary(params) {
  const client = params && params.client;
  const addMangaToLibrary = params && params.addMangaToLibrary;
  const link = params && params.link ? params.link : {};
  const fallbackTitle = String(params && params.fallbackTitle || '').trim();

  const mangaId = Number(link.mangaId);
  if (!Number.isFinite(mangaId)) {
    throw new Error('mangaId invalido para vincular no Suwayomi');
  }

  await addMangaToLibrary(client, mangaId);

  return {
    sourceId: String(link.sourceId || ''),
    sourceName: String(link.sourceName || link.sourceId || ''),
    mangaId,
    mangaTitle: String(link.mangaTitle || fallbackTitle || ''),
    updatedAt: new Date().toISOString()
  };
}

module.exports = {
  linkItemInLibrary
};
