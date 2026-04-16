const {
  scoreTitleMatch,
  isStrictTitleMatch
} = require('../services/title-match');

function scoreTitle(title1, title2) {
  return scoreTitleMatch(title1, title2);
}

function isStrictMatch(title1, title2, minScore) {
  return isStrictTitleMatch(title1, title2, minScore);
}

function bestMatchForItem(item, candidateTitle) {
  const searchKey = String(
    (item && (item.searchKey || item.title || item.name || item.romaji || item.english || item.native)) ||
      ''
  ).trim();

  if (!searchKey || !candidateTitle) return null;
  const score = scoreTitle(searchKey, candidateTitle);
  const strict = isStrictMatch(searchKey, candidateTitle);

  return {
    score,
    strict,
    inputTitle: searchKey,
    candidateTitle: String(candidateTitle)
  };
}

module.exports = {
  scoreTitle,
  isStrictMatch,
  bestMatchForItem
};