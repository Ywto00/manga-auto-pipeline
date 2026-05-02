/**
 * AniList GraphQL adapter.
 *
 * Handles:
 *  - Fetching user manga list via MediaListCollection
 *  - Fetching single media by ID (for metadata enrichment)
 */
const { postGraphQL } = require('../../shared/utils/api-common');

const USER_LIST_QUERY = `
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
    id chapters volumes format status
    description(asHtml: false) genres countryOfOrigin siteUrl
    startDate { year month day }
    coverImage { extraLarge large medium }
    title { userPreferred romaji english native }
  }
}
`;

/**
 * Maps raw AniList API response to a normalized item object.
 */
function normalizeAniListEntry(media, entryStatus, entryProgress) {
  return {
    id: media.id,
    source: 'anilist',
    title: (media.title && (media.title.userPreferred || media.title.romaji)) || '',
    altTitles: [
      media.title && media.title.romaji,
      media.title && media.title.english,
      media.title && media.title.native,
      media.title && media.title.userPreferred
    ].filter(Boolean),
    status: entryStatus,
    progress: entryProgress || 0,
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
      extraLarge: (media.coverImage && media.coverImage.extraLarge) ? String(media.coverImage.extraLarge) : '',
      large: (media.coverImage && media.coverImage.large) ? String(media.coverImage.large) : '',
      medium: (media.coverImage && media.coverImage.medium) ? String(media.coverImage.medium) : ''
    }
  };
}

/**
 * Fetches the full AniList manga collection for a user.
 */
async function fetchAniList(username) {
  const data = await postGraphQL(USER_LIST_QUERY, { user: username });
  const lists = (data && data.MediaListCollection && data.MediaListCollection.lists) || [];
  const items = [];
  for (const list of lists) {
    for (const entry of (list.entries || [])) {
      const media = entry.media || {};
      items.push(normalizeAniListEntry(media, entry.status, entry.progress));
    }
  }
  return items;
}

/**
 * Fetches a single AniList manga by its ID.
 */
async function fetchAniListMediaById(itemOrId) {
  const mediaId = typeof itemOrId === 'object'
    ? (itemOrId && Number.isFinite(Number(itemOrId.id)) ? Number(itemOrId.id) : null)
    : Number(itemOrId);

  if (!Number.isFinite(mediaId) || mediaId <= 0) return null;

  const data = await postGraphQL(MEDIA_BY_ID_QUERY, { id: mediaId });
  const media = data && data.Media ? data.Media : null;
  if (!media) return null;

  return {
    id: media.id,
    source: 'anilist',
    title: (media.title && (media.title.userPreferred || media.title.romaji)) || '',
    altTitles: [
      media.title && media.title.romaji,
      media.title && media.title.english,
      media.title && media.title.native,
      media.title && media.title.userPreferred
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
      extraLarge: (media.coverImage && media.coverImage.extraLarge) ? String(media.coverImage.extraLarge) : '',
      large: (media.coverImage && media.coverImage.large) ? String(media.coverImage.large) : '',
      medium: (media.coverImage && media.coverImage.medium) ? String(media.coverImage.medium) : ''
    }
  };
}

module.exports = { fetchAniList, fetchAniListMediaById };
