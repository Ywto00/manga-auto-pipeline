const { fetchAniList } = require('../infra/sync/anilist-adapter');

async function fetchUserList(provider, username) {
  if (String(provider || 'anilist').toLowerCase() !== 'anilist') {
    throw new Error('Only AniList provider is supported');
  }

  const mapped = await fetchAniList(username);
  const readingLike = mapped.filter((item) => {
    const status = String((item && item.status) || '').toUpperCase();
    return status === 'CURRENT' || status === 'REPEATING' || status === 'PAUSED' || status === 'PLANNING';
  });

  return { mapped, readingLike };
}

module.exports = { fetchUserList };
