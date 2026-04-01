
//Jikan deprecated
const { getJson, sleep, paginateAsync } = require('./api-common');

async function fetchMAL(username) {
  return paginateAsync(async (page) => {
    try {
      const url = `https://api.jikan.moe/v4/users/${username}/mangalist/all?page=${page}`;
      const json = await getJson(url);
      const data = json.data || [];
      const items = data.map(entry => ({
        id: entry.manga.mal_id,
        source: 'mal',
        title: entry.manga.title,
        altTitles: [
          entry.manga.title,
          ...(Array.isArray(entry.manga.titles)
            ? entry.manga.titles.map(t => t && t.title).filter(Boolean)
            : [])
        ],
        status: entry.status,
        progress: entry.reading_progress || entry.chapters_read || 0
      }));
      const hasNext = Boolean(json.pagination?.has_next_page);
      await sleep(1000);
      return { items, hasNext };
    } catch (e) {
      console.error('MyAnimeList error:', e.message);
      return { items: [], hasNext: false };
    }
  });
}

module.exports = { fetchMAL };