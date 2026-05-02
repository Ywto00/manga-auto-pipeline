const { postGraphQL } = require('../utils/api-common');

const QUERY = `
query ($user: String) {
  MediaListCollection(userName: $user, type: MANGA) {
    lists {
      entries {
        media {
          id
          chapters
          volumes
          format
          status
          description(asHtml: false)
          genres
          countryOfOrigin
          siteUrl
          startDate { year month day }
          coverImage { extraLarge large medium }
          title { userPreferred romaji english native }
        }
        status
        progress
      }
    }
  }
}
`;

const MEDIA_BY_ID_QUERY = `
query ($id: Int) {
  Media(id: $id, type: MANGA) {
    id
    chapters
    volumes
    format
    status
    description(asHtml: false)
    genres
    countryOfOrigin
    siteUrl
    startDate { year month day }
    coverImage { extraLarge large medium }
    title { userPreferred romaji english native }
  }
}
`;

async function fetchAniList(username) {
  const data = await postGraphQL(QUERY, { user: username });
  const lists = data?.MediaListCollection?.lists || [];
  const items = [];
  for (const list of lists) {
    for (const entry of list.entries || []) {
      const media = entry.media || {};
      items.push({
        id: media.id,
        source: 'anilist',
        title: media.title?.userPreferred || media.title?.romaji || '',
        altTitles: [
          media.title?.romaji,
          media.title?.english,
          media.title?.native,
          media.title?.userPreferred
        ].filter(Boolean),
        status: entry.status,
        progress: entry.progress || 0,
        totalChapters: Number.isFinite(Number(media.chapters)) ? Number(media.chapters) : null,
        totalVolumes: Number.isFinite(Number(media.volumes)) ? Number(media.volumes) : null,
        format: media.format || '',
        mediaStatus: media.status || '',
        description: media.description || '',
        genres: Array.isArray(media.genres) ? media.genres.filter(Boolean) : [],
        countryOfOrigin: media.countryOfOrigin || '',
        siteUrl: media.siteUrl || '',
        startYear: media.startDate && Number.isFinite(Number(media.startDate.year)) ? Number(media.startDate.year) : null,
        coverImage: {
          extraLarge: media.coverImage && media.coverImage.extraLarge ? String(media.coverImage.extraLarge) : '',
          large: media.coverImage && media.coverImage.large ? String(media.coverImage.large) : '',
          medium: media.coverImage && media.coverImage.medium ? String(media.coverImage.medium) : ''
        }
      });
    }
  }
  return items;
}

async function fetchAniListMediaById(id) {
  const mediaId = Number(id);
  if (!Number.isFinite(mediaId) || mediaId <= 0) return null;

  const data = await postGraphQL(MEDIA_BY_ID_QUERY, { id: mediaId });
  const media = data && data.Media ? data.Media : null;
  if (!media) return null;

  return {
    id: media.id,
    source: 'anilist',
    title: media.title?.userPreferred || media.title?.romaji || '',
    altTitles: [
      media.title?.romaji,
      media.title?.english,
      media.title?.native,
      media.title?.userPreferred
    ].filter(Boolean),
    totalChapters: Number.isFinite(Number(media.chapters)) ? Number(media.chapters) : null,
    totalVolumes: Number.isFinite(Number(media.volumes)) ? Number(media.volumes) : null,
    format: media.format || '',
    mediaStatus: media.status || '',
    status: media.status || '',
    description: media.description || '',
    genres: Array.isArray(media.genres) ? media.genres.filter(Boolean) : [],
    countryOfOrigin: media.countryOfOrigin || '',
    siteUrl: media.siteUrl || '',
    startYear: media.startDate && Number.isFinite(Number(media.startDate.year)) ? Number(media.startDate.year) : null,
    coverImage: {
      extraLarge: media.coverImage && media.coverImage.extraLarge ? String(media.coverImage.extraLarge) : '',
      large: media.coverImage && media.coverImage.large ? String(media.coverImage.large) : '',
      medium: media.coverImage && media.coverImage.medium ? String(media.coverImage.medium) : ''
    }
  };
}

module.exports = { fetchAniList, fetchAniListMediaById };